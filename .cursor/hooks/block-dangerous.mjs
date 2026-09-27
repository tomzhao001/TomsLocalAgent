const raw = await new Response(process.stdin).text();
const payload = raw ? JSON.parse(raw) : {};
const command = String(payload.command ?? "");
if (/git\s+push\b[\s\S]*--force/i.test(command) || /rm\s+-rf\b/i.test(command)) {
  console.error("已拦截危险命令");
  process.exit(2);
}
