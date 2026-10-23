/** 桌宠接口失败：HTTP 非 2xx，或业务失败（`ok: false`，看 `reason`）。 */
export class PetApiError extends Error {
  /** 出错的接口路径，不含查询参数，例如 `/lock`。 */
  readonly path: string;
  /** 收到响应时的 HTTP 状态码。 */
  readonly status: number | undefined;
  /** 桌宠给的失败原因，例如 `locked`、`unknown-owner`；读不懂响应时是 `bad-response`。 */
  readonly reason: string | undefined;

  constructor(
    message: string,
    details: { readonly path: string; readonly status?: number; readonly reason?: string | undefined },
  ) {
    super(message);
    this.name = 'PetApiError';
    this.path = details.path;
    this.status = details.status;
    this.reason = details.reason;
  }
}
