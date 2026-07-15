#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <Foundation/Foundation.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct RuntimePaths {
    char root[PATH_MAX];
    char home[PATH_MAX];
    char config[PATH_MAX];
    char data[PATH_MAX];
    char cache[PATH_MAX];
    char state[PATH_MAX];
    char temp[PATH_MAX];
    char workspace[PATH_MAX];
} RuntimePaths;

/* Joins two path segments and rejects truncation. */
static int join_path(char *output, size_t size, const char *left, const char *right)
{
    int written = snprintf(output, size, "%s/%s", left, right);
    if (written < 0 || (size_t)written >= size) {
        fprintf(stderr, "[sandbox-error] path is too long\n");
        return -1;
    }
    return 0;
}
/* Formats one environment entry and rejects truncation. */
static int format_environment(char *output, size_t size, const char *name, const char *value)
{
    int written = snprintf(output, size, "%s=%s", name, value);
    if (written < 0 || (size_t)written >= size) {
        fprintf(stderr, "[sandbox-error] environment value is too long\n");
        return -1;
    }
    return 0;
}


/* Creates one directory and accepts an existing directory. */
static int ensure_directory(const char *path)
{
    if (mkdir(path, 0700) == 0 || errno == EEXIST) {
        return 0;
    }
    fprintf(stderr, "[sandbox-error] mkdir %s: %s\n", path, strerror(errno));
    return -1;
}

/* Removes the final path component in place. */
static int parent_directory(char *path)
{
    char *slash = strrchr(path, '/');
    if (slash == NULL || slash == path) {
        return -1;
    }
    *slash = '\0';
    return 0;
}

/* Resolves the OpenCode executable embedded in the app bundle. */
static int resolve_opencode(char *output, size_t size)
{
    char executable[PATH_MAX];
    char resolved[PATH_MAX];
    uint32_t executable_size = sizeof(executable);

    if (_NSGetExecutablePath(executable, &executable_size) != 0) {
        fprintf(stderr, "[sandbox-error] launcher path is too long\n");
        return -1;
    }
    if (realpath(executable, resolved) == NULL) {
        fprintf(stderr, "[sandbox-error] realpath launcher: %s\n", strerror(errno));
        return -1;
    }
    if (parent_directory(resolved) != 0 || parent_directory(resolved) != 0) {
        fprintf(stderr, "[sandbox-error] invalid app bundle layout\n");
        return -1;
    }
    return join_path(output, size, resolved, "Resources/opencode");
}

/* Creates isolated data directories inside the App Sandbox container. */
static int prepare_runtime(RuntimePaths *runtime)
{
    NSString *home_directory = NSHomeDirectory();
    const char *container_home = [home_directory fileSystemRepresentation];
    char original_home[PATH_MAX];
    FILE *marker;

    if (home_directory == nil || container_home == NULL || container_home[0] == '\0') {
        fprintf(stderr, "[sandbox-error] App Sandbox HOME is unavailable\n");
        return -1;
    }
    if (snprintf(original_home, sizeof(original_home), "%s", container_home) >= (int)sizeof(original_home)) {
        fprintf(stderr, "[sandbox-error] App Sandbox HOME is too long\n");
        return -1;
    }

    if (join_path(runtime->root, sizeof(runtime->root), original_home, "opencode-sandbox-prototype") != 0 ||
        join_path(runtime->home, sizeof(runtime->home), runtime->root, "home") != 0 ||
        join_path(runtime->config, sizeof(runtime->config), runtime->root, "xdg-config") != 0 ||
        join_path(runtime->data, sizeof(runtime->data), runtime->root, "xdg-data") != 0 ||
        join_path(runtime->cache, sizeof(runtime->cache), runtime->root, "xdg-cache") != 0 ||
        join_path(runtime->state, sizeof(runtime->state), runtime->root, "xdg-state") != 0 ||
        join_path(runtime->temp, sizeof(runtime->temp), runtime->root, "tmp") != 0 ||
        join_path(runtime->workspace, sizeof(runtime->workspace), runtime->root, "workspace") != 0) {
        return -1;
    }

    if (ensure_directory(runtime->root) != 0 ||
        ensure_directory(runtime->home) != 0 ||
        ensure_directory(runtime->config) != 0 ||
        ensure_directory(runtime->data) != 0 ||
        ensure_directory(runtime->cache) != 0 ||
        ensure_directory(runtime->state) != 0 ||
        ensure_directory(runtime->temp) != 0 ||
        ensure_directory(runtime->workspace) != 0) {
        return -1;
    }

    if (chdir(runtime->workspace) != 0) {
        fprintf(stderr, "[sandbox-error] chdir workspace: %s\n", strerror(errno));
        return -1;
    }

    marker = fopen("inside.txt", "wb");
    if (marker == NULL) {
        fprintf(stderr, "[sandbox-error] create marker: %s\n", strerror(errno));
        return -1;
    }
    fputs("sandbox-inside-marker\n", marker);
    fclose(marker);


    fprintf(stderr, "[sandbox-root] %s\n", runtime->root);
    return 0;
}

/* Reads a file with the launcher's own App Sandbox token. */
static int read_probe(const char *path)
{
    char buffer[4096];
    size_t count;
    FILE *file = fopen(path, "rb");

    if (file == NULL) {
        fprintf(stderr, "[probe-denied] %s: %s\n", path, strerror(errno));
        return 13;
    }

    while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        if (fwrite(buffer, 1, count, stdout) != count) {
            fclose(file);
            return 14;
        }
    }
    fclose(file);
    return 0;
}

/* Runs a direct file probe or replaces the launcher with bundled OpenCode. */
static int run(int argc, char **argv)
{
    RuntimePaths runtime;
    char opencode[PATH_MAX];
    char env_home[PATH_MAX + 32];
    char env_config[PATH_MAX + 32];
    char env_data[PATH_MAX + 32];
    char env_cache[PATH_MAX + 32];
    char env_state[PATH_MAX + 32];
    char env_temp[PATH_MAX + 32];
    char env_path[] = "PATH=/usr/bin:/bin";
    char env_lang[] = "LANG=en_US.UTF-8";
    char env_locale[] = "LC_ALL=en_US.UTF-8";
    char env_user[] = "USER=opencode-sandbox";
    char env_shell[] = "SHELL=/bin/sh";
    char *child_env[12];
    char **child_argv;
    int index;

    if (prepare_runtime(&runtime) != 0) {
        return 1;
    }

    if (argc == 3 && strcmp(argv[1], "--read") == 0) {
        return read_probe(argv[2]);
    }

    if (resolve_opencode(opencode, sizeof(opencode)) != 0) {
        return 1;
    }

    if (format_environment(env_home, sizeof(env_home), "HOME", runtime.home) != 0 ||
        format_environment(env_config, sizeof(env_config), "XDG_CONFIG_HOME", runtime.config) != 0 ||
        format_environment(env_data, sizeof(env_data), "XDG_DATA_HOME", runtime.data) != 0 ||
        format_environment(env_cache, sizeof(env_cache), "XDG_CACHE_HOME", runtime.cache) != 0 ||
        format_environment(env_state, sizeof(env_state), "XDG_STATE_HOME", runtime.state) != 0 ||
        format_environment(env_temp, sizeof(env_temp), "TMPDIR", runtime.temp) != 0) {
        return 1;
    }

    child_env[0] = env_home;
    child_env[1] = env_config;
    child_env[2] = env_data;
    child_env[3] = env_cache;
    child_env[4] = env_state;
    child_env[5] = env_temp;
    child_env[6] = env_path;
    child_env[7] = env_lang;
    child_env[8] = env_locale;
    child_env[9] = env_user;
    child_env[10] = env_shell;
    child_env[11] = NULL;

    child_argv = calloc((size_t)argc + 1, sizeof(char *));
    if (child_argv == NULL) {
        fprintf(stderr, "[sandbox-error] allocate argv: %s\n", strerror(errno));
        return 1;
    }

    child_argv[0] = opencode;
    for (index = 1; index < argc; index++) {
        child_argv[index] = argv[index];
    }
    child_argv[argc] = NULL;

    execve(opencode, child_argv, child_env);
    fprintf(stderr, "[sandbox-error] exec OpenCode: %s\n", strerror(errno));
    free(child_argv);
    return 1;
}

/* Owns the Foundation autorelease pool used to resolve the sandbox home. */
int main(int argc, char **argv)
{
    @autoreleasepool {
        return run(argc, argv);
    }
}
