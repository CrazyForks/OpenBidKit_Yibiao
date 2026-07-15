#define _DARWIN_C_SOURCE

#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t requested_signal = 0;

/* 记录需要转发给沙箱进程组的终止信号。 */
static void handle_signal(int signal_number)
{
    requested_signal = signal_number;
}

/* 安装 supervisor 使用的生命周期信号处理器。 */
static int install_signal_handlers(void)
{
    struct sigaction action;

    memset(&action, 0, sizeof(action));
    action.sa_handler = handle_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0) {
        fprintf(stderr, "[opencode-sandbox] install signal handlers: %s\n", strerror(errno));
        return -1;
    }
    return 0;
}

/* 在 exec 前恢复子进程的默认信号行为。 */
static int reset_child_signal_handlers(void)
{
    struct sigaction action;

    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0) {
        return -1;
    }
    return 0;
}

/* 移除路径末尾一级目录。 */
static int remove_last_component(char *path)
{
    char *separator = strrchr(path, '/');
    if (separator == NULL || separator == path) {
        return -1;
    }
    *separator = '\0';
    return 0;
}

/* 定位助手 App 内的 Resources/bin 目录。 */
static int resolve_bin_directory(char *output, size_t output_size)
{
    char launcher_path[PATH_MAX];
    char resolved_path[PATH_MAX];
    uint32_t launcher_path_size = sizeof(launcher_path);
    int written;

    if (_NSGetExecutablePath(launcher_path, &launcher_path_size) != 0) {
        fprintf(stderr, "[opencode-sandbox] launcher path is too long\n");
        return -1;
    }
    if (realpath(launcher_path, resolved_path) == NULL) {
        fprintf(stderr, "[opencode-sandbox] resolve launcher path: %s\n", strerror(errno));
        return -1;
    }
    if (remove_last_component(resolved_path) != 0 || remove_last_component(resolved_path) != 0) {
        fprintf(stderr, "[opencode-sandbox] invalid app bundle layout\n");
        return -1;
    }

    written = snprintf(output, output_size, "%s/Resources/bin", resolved_path);
    if (written < 0 || (size_t)written >= output_size) {
        fprintf(stderr, "[opencode-sandbox] embedded bin path is too long\n");
        return -1;
    }
    return 0;
}

/* 校验目标是 Resources/bin 内的直接子可执行文件。 */
static int resolve_embedded_executable(const char *requested_path, char *output, size_t output_size)
{
    char bin_directory[PATH_MAX];
    char target_parent[PATH_MAX];

    if (requested_path == NULL || requested_path[0] != '/') {
        fprintf(stderr, "[opencode-sandbox] embedded executable path must be absolute\n");
        return -1;
    }
    if (resolve_bin_directory(bin_directory, sizeof(bin_directory)) != 0) {
        return -1;
    }
    if (realpath(requested_path, output) == NULL) {
        fprintf(stderr, "[opencode-sandbox] resolve embedded executable: %s\n", strerror(errno));
        return -1;
    }
    if (snprintf(target_parent, sizeof(target_parent), "%s", output) >= (int)sizeof(target_parent) ||
        remove_last_component(target_parent) != 0 || strcmp(target_parent, bin_directory) != 0) {
        fprintf(stderr, "[opencode-sandbox] executable is outside Contents/Resources/bin\n");
        return -1;
    }
    if (access(output, X_OK) != 0) {
        fprintf(stderr, "[opencode-sandbox] embedded executable is not executable: %s\n", strerror(errno));
        return -1;
    }
    if (strlen(output) + 1 > output_size) {
        fprintf(stderr, "[opencode-sandbox] embedded executable path is too long\n");
        return -1;
    }
    return 0;
}

/* 严格解析 Electron 提供的父进程 PID。 */
static int parse_parent_pid(const char *value, pid_t *parent_pid)
{
    char *end = NULL;
    long parsed;

    errno = 0;
    parsed = strtol(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed <= 1 || parsed > INT_MAX) {
        fprintf(stderr, "[opencode-sandbox] invalid parent pid\n");
        return -1;
    }
    *parent_pid = (pid_t)parsed;
    if (*parent_pid != getppid()) {
        fprintf(stderr, "[opencode-sandbox] parent pid does not match direct parent\n");
        return -1;
    }
    if (kill(*parent_pid, 0) != 0) {
        fprintf(stderr, "[opencode-sandbox] parent process cannot be monitored: %s\n", strerror(errno));
        return -1;
    }
    return 0;
}

/* 短暂等待 supervisor 的下一轮生命周期检查。 */
static void wait_for_poll_interval(void)
{
    struct timespec interval;

    interval.tv_sec = 0;
    interval.tv_nsec = 200000000L;
    while (nanosleep(&interval, &interval) != 0 && errno == EINTR && requested_signal == 0) {
    }
}

/* 将信号发送给完整的 OpenCode 子进程组。 */
static void signal_process_group(pid_t group_id, int signal_number)
{
    if (kill(-group_id, signal_number) != 0 && errno != ESRCH) {
        fprintf(stderr, "[opencode-sandbox] signal process group: %s\n", strerror(errno));
    }
}

/* 检查目标进程组是否仍有存活成员。 */
static int process_group_exists(pid_t group_id)
{
    if (kill(-group_id, 0) == 0 || errno == EPERM) {
        return 1;
    }
    return 0;
}

/* 终止子进程组并回收直接子进程。 */
static void terminate_process_group(pid_t child_pid, int first_signal, int child_already_reaped)
{
    int status;
    int attempt;

    signal_process_group(child_pid, first_signal);
    for (attempt = 0; attempt < 10; attempt++) {
        if (!child_already_reaped) {
            pid_t waited = waitpid(child_pid, &status, WNOHANG);
            if (waited == child_pid || (waited < 0 && errno == ECHILD)) {
                child_already_reaped = 1;
            }
        }
        if (!process_group_exists(child_pid)) {
            return;
        }
        wait_for_poll_interval();
    }
    signal_process_group(child_pid, SIGKILL);
    if (!child_already_reaped) {
        while (waitpid(child_pid, &status, 0) < 0 && errno == EINTR) {
        }
    }
}

/* 判断指定进程是否仍然存在。 */
static int process_exists(pid_t pid)
{
    if (kill(pid, 0) == 0 || errno == EPERM) {
        return 1;
    }
    return 0;
}

/* 在主启动器异常退出时独立清理 OpenCode 进程组。 */
static int watch_supervisor(pid_t parent_pid, pid_t supervisor_pid, pid_t child_pid)
{
    for (;;) {
        if (requested_signal != 0) {
            int signal_number = requested_signal;
            terminate_process_group(child_pid, signal_number, 1);
            return 128 + signal_number;
        }
        if (!process_group_exists(child_pid)) {
            return 0;
        }
        if (getppid() != supervisor_pid ||
            !process_exists(supervisor_pid) ||
            !process_exists(parent_pid)) {
            terminate_process_group(child_pid, SIGTERM, 1);
            return 0;
        }
        wait_for_poll_interval();
    }
}

/* 停止并回收当前启动器创建的看门进程。 */
static void stop_watchdog(pid_t watchdog_pid)
{
    int status;
    int attempt;

    if (watchdog_pid <= 0) {
        return;
    }
    if (kill(watchdog_pid, SIGTERM) != 0 && errno != ESRCH) {
        fprintf(stderr, "[opencode-sandbox] stop watchdog: %s\n", strerror(errno));
    }
    for (attempt = 0; attempt < 10; attempt++) {
        pid_t waited = waitpid(watchdog_pid, &status, WNOHANG);
        if (waited == watchdog_pid || (waited < 0 && errno == ECHILD)) {
            return;
        }
        if (waited < 0 && errno != EINTR) {
            fprintf(stderr, "[opencode-sandbox] wait watchdog: %s\n", strerror(errno));
            return;
        }
        wait_for_poll_interval();
    }
    if (kill(watchdog_pid, SIGKILL) != 0 && errno != ESRCH) {
        fprintf(stderr, "[opencode-sandbox] kill watchdog: %s\n", strerror(errno));
    }
    while (waitpid(watchdog_pid, &status, 0) < 0 && errno == EINTR) {
    }
}

/* 将 waitpid 状态转换为进程退出码。 */
static int child_exit_code(int status)
{
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 70;
}

/* 监测 Electron 和沙箱进程组的完整生命周期。 */
static int supervise(pid_t parent_pid, pid_t child_pid, pid_t watchdog_pid)
{
    int status;

    for (;;) {
        pid_t waited;

        if (requested_signal != 0) {
            int signal_number = requested_signal;
            terminate_process_group(child_pid, signal_number, 0);
            stop_watchdog(watchdog_pid);
            return 128 + signal_number;
        }

        waited = waitpid(child_pid, &status, WNOHANG);
        if (waited == child_pid) {
            int exit_code = child_exit_code(status);
            terminate_process_group(child_pid, SIGTERM, 1);
            stop_watchdog(watchdog_pid);
            return exit_code;
        }
        if (waited < 0 && errno != EINTR) {
            fprintf(stderr, "[opencode-sandbox] wait child process: %s\n", strerror(errno));
            terminate_process_group(child_pid, SIGTERM, errno == ECHILD);
            stop_watchdog(watchdog_pid);
            return 70;
        }

        if (getppid() != parent_pid) {
            terminate_process_group(child_pid, SIGTERM, 0);
            stop_watchdog(watchdog_pid);
            return 143;
        }
        if (kill(parent_pid, 0) != 0) {
            if (errno == ESRCH) {
                terminate_process_group(child_pid, SIGTERM, 0);
                stop_watchdog(watchdog_pid);
                return 143;
            }
            fprintf(stderr, "[opencode-sandbox] parent process can no longer be monitored: %s\n", strerror(errno));
            terminate_process_group(child_pid, SIGTERM, 0);
            stop_watchdog(watchdog_pid);
            return 70;
        }
        wait_for_poll_interval();
    }
}

/* 启动同一 App Sandbox 内的受限程序并监管其进程组。 */
int main(int argc, char **argv, char **envp)
{
    char executable_path[PATH_MAX];
    char **child_argv;
    pid_t parent_pid;
    pid_t child_pid;
    pid_t supervisor_pid;
    pid_t watchdog_pid;
    int index;

    if (argc < 4 || strcmp(argv[1], "--parent-pid") != 0) {
        fprintf(stderr, "[opencode-sandbox] usage: launcher --parent-pid <pid> <embedded-executable> [args...]\n");
        return 64;
    }
    if (parse_parent_pid(argv[2], &parent_pid) != 0 ||
        resolve_embedded_executable(argv[3], executable_path, sizeof(executable_path)) != 0 ||
        install_signal_handlers() != 0) {
        return 70;
    }

    child_argv = calloc((size_t)argc - 2, sizeof(char *));
    if (child_argv == NULL) {
        fprintf(stderr, "[opencode-sandbox] allocate arguments: %s\n", strerror(errno));
        return 70;
    }
    child_argv[0] = executable_path;
    for (index = 4; index < argc; index++) {
        child_argv[index - 3] = argv[index];
    }
    child_argv[argc - 3] = NULL;

    child_pid = fork();
    if (child_pid < 0) {
        fprintf(stderr, "[opencode-sandbox] fork embedded executable: %s\n", strerror(errno));
        free(child_argv);
        return 70;
    }
    if (child_pid == 0) {
        if (setpgid(0, 0) != 0 || reset_child_signal_handlers() != 0) {
            fprintf(stderr, "[opencode-sandbox] prepare child process group: %s\n", strerror(errno));
            _exit(70);
        }
        execve(executable_path, child_argv, envp);
        fprintf(stderr, "[opencode-sandbox] exec embedded executable: %s\n", strerror(errno));
        _exit(70);
    }

    if (setpgid(child_pid, child_pid) != 0 && errno != EACCES && errno != ESRCH) {
        fprintf(stderr, "[opencode-sandbox] establish child process group: %s\n", strerror(errno));
        terminate_process_group(child_pid, SIGTERM, 0);
        free(child_argv);
        return 70;
    }

    supervisor_pid = getpid();
    watchdog_pid = fork();
    if (watchdog_pid < 0) {
        fprintf(stderr, "[opencode-sandbox] fork watchdog: %s\n", strerror(errno));
        terminate_process_group(child_pid, SIGTERM, 0);
        free(child_argv);
        return 70;
    }
    if (watchdog_pid == 0) {
        free(child_argv);
        return watch_supervisor(parent_pid, supervisor_pid, child_pid);
    }

    free(child_argv);
    return supervise(parent_pid, child_pid, watchdog_pid);
}
