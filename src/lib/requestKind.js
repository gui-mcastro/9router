// "meta" requests only read router metadata (model lists, voices, token counts,
// async job status). Everything else asks a provider to do work.
const META_PATHS = [
  /^\/v1\/?$/,
  /^\/v1\/models(\/|$)/,
  /^\/v1\/audio\/voices\/?$/,
  /^\/v1\/messages\/count_tokens\/?$/,
  /^\/v1beta\/models\/?$/,
];
const META_GET_PATHS = [/^\/v1\/videos\/[^/]+\/?$/];

export function classifyRequestKind(method, pathname) {
  const path = String(pathname || "").replace(/^\/api(?=\/v1)/, "");
  if (META_PATHS.some((re) => re.test(path))) return "meta";
  if (String(method || "").toUpperCase() === "GET" && META_GET_PATHS.some((re) => re.test(path))) return "meta";
  return "work";
}
