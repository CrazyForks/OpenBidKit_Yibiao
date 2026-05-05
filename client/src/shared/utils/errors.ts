export class ClientNotImplementedError extends Error {
  constructor(featureName: string) {
    super(`${featureName} 尚未实现`);
    this.name = 'ClientNotImplementedError';
  }
}

export const getErrorMessage = (error: unknown, fallback = '操作失败'): string => {
  if (error instanceof Error) {
    return error.message || fallback;
  }

  if (typeof error === 'string') {
    return error;
  }

  return fallback;
};
