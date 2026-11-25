import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, readFile, writeFile, mkdir, mkdtemp, lstat, realpath, readlink, rename, rm, open } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

const messages = JSON.parse(await readFile(new URL("./zh-CN.json", import.meta.url), "utf8")).messages
export const migrationText = key => messages[key] || key
const repository = "https://github.com/MOPELotus/Lotus-Yunzai.git"
const wait = ms => new Promise(done => setTimeout(done, ms))
const exists = async path => !!await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error })

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || await realpath(path) !== path || info.mode & 0o077 || info.uid !== process.getuid?.()) {
    throw Error(migrationText("unsafe"))
  }
}
async function readState(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.uid !== process.getuid?.() || await realpath(path) !== path) {
    throw Error(migrationText("unsafe"))
  }
  return JSON.parse(await readFile(path, "utf8"))
}
async function initialState(path, value) {
  const temporary = path + "." + randomUUID()
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" })
  await rename(temporary, path)
}
export async function oldHostIdentity(pid = process.pid) {
  const [stat, execPath, cwd, command] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"), readlink(`/proc/${pid}/exe`), readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/cmdline`),
  ])
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const old = { pid, execPath, cwd, argv: command.toString().split("\0").filter(Boolean).slice(1), startTimeTicks: fields[19], env: { ...process.env } }
  if (pid === process.pid) old.restoreArgv = [...process.execArgv, ...process.argv.slice(1)]
  if (process.env.pm_id !== undefined) {
    if (!/^\d+$/.test(process.env.pm_id)) throw Error(migrationText("unsafe"))
    let cli = "pm2"
    for (const candidate of [join(cwd,"node_modules/.bin/pm2"), join(cwd,"node_modules/pm2/bin/pm2")]) {
      if (await access(candidate, constants.X_OK).then(() => true, () => false)) { cli = candidate; break }
    }
    old.pm2 = { id: Number(process.env.pm_id), cli }
  }
  return old
}
function execute(command, args, { cwd, env, log }) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", log, log] })
    child.once("error", reject)
    child.once("exit", (code, signal) => code === 0 ? done() : reject(Error(`${migrationText("command")} (${code ?? signal})`)))
  })
}
export async function launchMigrationWorker(command, args, options) {
  // A separate session still belongs to the parent's PID tree. Reparent before PM2 tree-kill.
  const bridge = `
    const { spawn } = require('node:child_process');
    process.once('message', ({command,args,cwd}) => {
      const env = {...process.env};
      for (const key of ['NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_UNIQUE_ID']) delete env[key];
      const worker = spawn(command,args,{cwd,env,detached:true,stdio:['ignore',1,2]});
      worker.once('error',()=>process.exit(1));
      worker.once('spawn',()=>{worker.unref();process.send({pid:worker.pid},()=>process.disconnect());});
    });
  `
  const child = spawn(process.execPath, ["-e", bridge], {
    cwd: options.cwd, env: options.env, stdio: ["ignore", options.log, options.log, "ipc"],
  })
  return new Promise((done, reject) => {
    let pid
    child.once("message", message => { if (Number.isSafeInteger(message?.pid) && message.pid > 1) pid = message.pid })
    child.once("error", reject)
    child.once("exit", code => code === 0 && pid ? done(pid) : reject(Error(migrationText("worker"))))
    child.send({ command, args, cwd: options.cwd })
  })
}

/** Prepare a new sibling checkout, then hand control to its independent migration worker. */
export async function migrateYunzai(options = {}) {
  const source = await realpath(options.source || process.cwd())
  if (!(await lstat(join(source, "plugins"))).isDirectory()) throw Error(migrationText("unsafe"))
  const parent = dirname(source)
  const control = join(parent, `.lotus-yunzai-migration-${basename(source)}`)
  await privateDirectory(control)
  const claim = join(control, "claim")
  try { await mkdir(claim, { mode: 0o700 }) }
  catch (error) { if (error.code === "EEXIST") throw Error(migrationText("busy")); throw error }
  let claimed = true
  const release = async () => { if (claimed) { await rm(claim, { recursive: true }); claimed = false } }
  try { return await migrateClaimed(options, source, parent, control, release) }
  finally { await release() }
}

async function migrateClaimed(options, source, parent, control, releaseClaim) {
  const host = options.oldHost || await oldHostIdentity()
  const lease = join(control, "active")
  try { await mkdir(lease, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== "EEXIST") throw error
    await privateDirectory(lease)
    const previous = await readState(join(lease, "lease.json"))
    if (typeof previous.state !== "string" || dirname(dirname(previous.state)) !== control) throw Error(migrationText("unsafe"))
    const status = await readState(previous.state)
    if (!["failed", "completed"].includes(status.phase)) throw Error(migrationText("busy"))
    await rm(lease, { recursive: true })
    await mkdir(lease, { mode: 0o700 })
  }
  const runDirectory = await mkdtemp(join(control, "run-"))
  const statePath = join(runDirectory, "state.json")
  const defaultTarget = join(parent, "Lotus-Yunzai")
  const target = options.target ? resolve(options.target) : await exists(defaultTarget)
    ? defaultTarget + "-" + Date.now() + "-" + randomUUID().slice(0, 6) : defaultTarget
  const environment = { ...process.env, ...(options.env || {}) }
  for (const name of ["pm_id", "NODE_APP_INSTANCE", "pm_exec_path", "pm_cwd", "NODE_OPTIONS", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"]) delete environment[name]
  const run = options.execute || execute, launch = options.launch || launchMigrationWorker
  const notify = options.onStep || (async () => {})
  let workerStarted = false
  await initialState(statePath, { version: 1, source, target, phase: "created", oldHost: host,
    requestedBy: String(options.requestedBy || ""), createdAt: new Date().toISOString() })
  await initialState(join(lease, "lease.json"), { state: statePath })
  await releaseClaim()
  const log = await open(join(runDirectory, "launcher.log"), "ax", 0o600)
  const context = { cwd: parent, env: environment, log: log.fd }
  try {
    if (target === source || dirname(target) !== parent || await exists(target)) throw Error(migrationText("unsafe"))
    await notify(migrationText("cloning"))
    try { await run("git", ["clone", "--single-branch", "--branch", "main", options.repository || repository, target], context) }
    catch { throw Error(migrationText("clone_failed")) }
    const worker = join(target, "scripts/legacy-migrate.mjs")
    if (!await exists(worker)) throw Error(migrationText("worker"))
    await initialState(statePath, { ...await readState(statePath), phase: "cloned" })
    const workerPid = await launch(process.execPath, [worker, "--source", source, "--state", statePath], { ...context, cwd: target })
    workerStarted = true
    let deadChecks = 0
    const fingerprint = options.launch ? null : await oldHostIdentity(workerPid).catch(() => null)
    const deadline = Date.now() + (options.timeoutMs || 45 * 60_000)
    let phase = ""
    while (Date.now() < deadline) {
      const status = await readState(statePath)
      if (!options.launch && status.phase !== "failed") {
        const current = await oldHostIdentity(workerPid).catch(error => {
          if (["ENOENT", "ESRCH"].includes(error.code)) return null
          throw error
        })
        const live = current && fingerprint && current.startTimeTicks === fingerprint.startTimeTicks &&
          current.execPath === fingerprint.execPath && current.cwd === fingerprint.cwd &&
          JSON.stringify(current.argv) === JSON.stringify(fingerprint.argv)
        deadChecks = live ? 0 : deadChecks + 1
        if (deadChecks >= 2) {
          if (["created", "cloned", "preparing", "installing", "ready-to-stop"].includes(status.phase)) {
            await initialState(statePath, { ...status, phase: "failed", failedStage: status.phase, recovery: "old-untouched" })
          }
          throw Error(migrationText("worker"))
        }
      }
      if (status.phase === "failed") throw Error(migrationText("failed"))
      if (status.phase === "ready-to-stop") {
        await notify(migrationText("ready"))
        await run(process.execPath, [worker, "--approve", "--source", source, "--state", statePath], { ...context, cwd: target })
        return { status: "handoff", source, target, statePath, log: join(runDirectory, "worker.log") }
      }
      if (status.phase !== phase && status.message) { phase = status.phase; await notify(status.message) }
      await (options.sleep || wait)(options.pollMs || 2000)
    }
    throw Error(migrationText("timeout"))
  } catch (error) {
    if (!workerStarted) {
      await initialState(statePath, { ...await readState(statePath), phase: "failed", error: error.message })
      // Keep the terminal lease; only a new claim owner may replace it.
    }
    error.migrationState = statePath
    throw error
  } finally { await log.close() }
}
