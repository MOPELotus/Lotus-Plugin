import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { migrateYunzai, oldHostIdentity } from "../migration/yunzai.js"

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
  assert.ok(!(await readdir(control)).includes("active"))
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
