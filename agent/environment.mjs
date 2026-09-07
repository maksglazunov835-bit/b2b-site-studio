// No PATH, NODE_OPTIONS, proxy, database, GitHub, Codex or application secrets.
export function runnerEnvironment(source = process.env) {
  const env = {};
  for (const key of ["SystemRoot","WINDIR","TEMP","TMP","LANG","LC_ALL"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}
