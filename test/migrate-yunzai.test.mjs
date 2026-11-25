import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { migrateYunzai, oldHostIdentity, launchMigrationWorker } from "../migration/yunzai.js"

async function fixture(run) {
  const parent = await mkdtemp(join(tmpdir(), "lotus-legacy-command-"))
  const source = join(parent, "old")
  await mkdir(join(source, "plugins"), { recursive: true })
  await writeFile(join(source, "keep.txt"), "original")
  try { await run(source, parent) } finally { await rm(parent, { recursive: true, force: true }) }
}

test("direct migration command clones a sibling and approves only after the final reply", () => fixture(async source => {
  const calls = [], messages = []
  let statePath
  const result = await migrateYunzai({ source, oldHost: { pid: 123 }, onStep: async message => messages.push(message),
    execute: async (command, args) => {
      calls.push([command, ...args])
      if (command === "git") {
        const target = args.at(-1)
        await mkdir(join(target, "scripts"), { recursive: true })
        await writeFile(join(target, "scripts/legacy-migrate.mjs"), "export {}")
      } else {
        assert.ok(args.includes("--approve"))
        assert.match(messages.at(-1), /即将停止旧机器人/)
        const state = JSON.parse(await readFile(statePath, "utf8"))
        await writeFile(statePath, JSON.stringify({ ...state, handoffApproved: true }))
      }
    }, launch: async (command, args) => {
      statePath = args.at(-1)
      const state = JSON.parse(await readFile(statePath, "utf8"))
      await writeFile(statePath, JSON.stringify({ ...state, phase: "ready-to-stop" }))
      return 456
    } })
  assert.equal(result.status, "handoff")
  assert.equal(dirname(result.target), dirname(source))
  assert.equal((await stat(dirname(result.statePath))).mode & 0o777, 0o700)
  assert.equal((await stat(result.statePath)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(result.statePath, "utf8")).handoffApproved, true)
  assert.equal(calls.filter(call => call[0] === "git").length, 1)
  assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "original")
  await assert.rejects(migrateYunzai({ source, oldHost: { pid: 123 } }), /正在进行/)
}))

test("clone failure never starts a worker and releases the command lock", () => fixture(async source => {
  let launches = 0
  await assert.rejects(migrateYunzai({ source, oldHost: { pid: 123 },
    execute: async () => { throw Error("offline") }, launch: async () => launches++ }), /旧机器人继续运行/)
  assert.equal(launches, 0)
  assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "original")
  const control = join(dirname(source), ".lotus-yunzai-migration-old")
  const lease = JSON.parse(await readFile(join(control,"active/lease.json"),"utf8"))
  assert.equal(JSON.parse(await readFile(lease.state,"utf8")).phase,"failed")
}))

test("an existing checkout is preserved and never overwritten", () => fixture(async (source, parent) => {
  const target = join(parent, "existing")
  await mkdir(target)
  await writeFile(join(target, "keep.txt"), "unrelated")
  await assert.rejects(migrateYunzai({ source, target, oldHost: { pid: 123 }, execute: async () => assert.fail("must not run") }), /不符合要求/)
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "unrelated")
}))

test("worker preparation failure is reported without approving shutdown", () => fixture(async source => {
  let approved = false
  await assert.rejects(migrateYunzai({ source, oldHost: { pid: 123 }, execute: async (command, args) => {
    if (command !== "git") { approved = true; return }
    await mkdir(join(args.at(-1), "scripts"), { recursive: true })
    await writeFile(join(args.at(-1), "scripts/legacy-migrate.mjs"), "export {}")
  }, launch: async (command, args) => {
    const file = args.at(-1), state = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...state, phase: "failed", recovery: "old-untouched" }))
  } }), /迁移未完成/)
  assert.equal(approved, false)
}))

test("only explicit masters may invoke the one-step command", async () => {
  globalThis.plugin = class { constructor(config) { this.config = config } }
  const { LotusYunzaiMigration } = await import("../apps/migrateYunzai.js")
  const command = new LotusYunzaiMigration(), replies = []
  assert.equal(command.config.rule[0].reg, "^#迁移荷花云崽$")
  for (const isMaster of [undefined, false]) {
    command.e = { isMaster, reply: async message => replies.push(message) }
    assert.equal(await command.migrate(), true)
  }
  assert.deepEqual(replies, ["仅主人可使用此指令。", "仅主人可使用此指令。"])
})

test("host identity retains original argv and private environment for recovery", async () => {
  const identity = await oldHostIdentity()
  assert.equal(identity.pid, process.pid)
  assert.ok(identity.argv.length)
  assert.match(identity.startTimeTicks, /^\d+$/)
  assert.equal(identity.env.PATH, process.env.PATH)
})

 test("同时重试终态lease只允许一次克隆", () => fixture(async (source, parent) => {
  const control = join(parent, ".lotus-yunzai-migration-old"), oldRun = join(control,"run-old"), active = join(control,"active");
  await mkdir(oldRun,{recursive:true,mode:0o700});await mkdir(active,{mode:0o700});
  await writeFile(join(oldRun,"state.json"),JSON.stringify({phase:"failed"}),{mode:0o600});
  await writeFile(join(active,"lease.json"),JSON.stringify({state:join(oldRun,"state.json")}),{mode:0o600});
  let release, clones=0;const barrier = new Promise(done=>release=done);
  const options={source,oldHost:{pid:123},execute:async()=>{clones++;await barrier;throw Error("offline")}};
  const first=migrateYunzai(options);
  while(!clones)await new Promise(done=>setTimeout(done,5));
  await assert.rejects(migrateYunzai(options),/正在进行/);release();
  await assert.rejects(first);assert.equal(clones,1);
}));

test("真实worker通过桥接脱离旧bot子孙树，环境不含IPC句柄", () => fixture(async (source,parent) => {
  const output=join(parent,"worker.json"),script=join(parent,"fake-worker.mjs");
  await writeFile(script,`import {writeFile} from 'node:fs/promises';await writeFile(process.argv[2],JSON.stringify({pid:process.pid,ppid:process.ppid,channel:process.env.NODE_CHANNEL_FD}));setInterval(()=>{},1000);`);
  const log=await open(join(parent,"bridge.log"),"w");let pid;
  try{
    pid=await launchMigrationWorker(process.execPath,[script,output],{cwd:source,env:process.env,log:log.fd});
    for(let i=0;i<100&&!await readFile(output).catch(()=>null);i++)await new Promise(done=>setTimeout(done,10));
    const data=JSON.parse(await readFile(output,"utf8"));assert.equal(data.pid,pid);assert.notEqual(data.ppid,process.pid);assert.equal(data.channel,undefined);
    process.kill(pid,0);
  }finally{if(pid)try{process.kill(pid,"SIGTERM")}catch{}await log.close()}
}));

test("准备阶段worker退出时明确失败，旧目录原件保留", () => fixture(async source => {
  let statePath;
  try{await migrateYunzai({source,oldHost:{pid:123},pollMs:10,timeoutMs:2000,execute:async(command,args)=>{
    if(command!=="git")assert.fail("不能批准已退出的worker");
    await mkdir(join(args.at(-1),"scripts"),{recursive:true});
    await writeFile(join(args.at(-1),"scripts/legacy-migrate.mjs"),"export {}");
  }})}catch(error){statePath=error.migrationState}
  assert.ok(statePath);const status=JSON.parse(await readFile(statePath,"utf8"));
  assert.equal(status.phase,"failed");assert.equal(status.recovery,"old-untouched");
  assert.equal(await readFile(join(source,"keep.txt"),"utf8"),"original");
}));
