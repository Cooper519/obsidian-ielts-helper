/** 只有本地构造且不含凭据的提示可以直接显示；系统、网络和解析异常不回显。 */
export class UserError extends Error {}

export function userMessage(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : "操作失败，请检查路径、网络与配置后重试";
}
