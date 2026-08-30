export class ApiError extends Error {
  constructor(message, {status = 0, path = ""} = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

export async function requestJson(path, options = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(path, options);
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).detail || message;
    } catch (_) {
      // 非 JSON 错误也保留 HTTP 状态文本，避免解析异常覆盖真正原因。
    }
    throw new ApiError(message, {status:response.status, path});
  }
  return response.json();
}

export async function requestFloat32(path, {
  minimumSchemaVersion,
  maximumSchemaVersion,
  fetchImpl = globalThis.fetch,
} = {}) {
  const response = await fetchImpl(path, {cache:"no-store"});
  if (!response.ok) {
    throw new ApiError(response.statusText, {status:response.status, path});
  }
  const schemaVersion = Number(response.headers.get("X-Schema-Version"));
  if (
    !Number.isInteger(schemaVersion)
    || schemaVersion < minimumSchemaVersion
    || schemaVersion > maximumSchemaVersion
  ) {
    throw new ApiError("二进制数据版本不兼容", {status:response.status, path});
  }
  return {
    samples:new Float32Array(await response.arrayBuffer()),
    schemaVersion,
    sampleRateHz:Number(response.headers.get("X-Sample-Rate-Hz")),
  };
}
