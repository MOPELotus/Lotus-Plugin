import { migrateYunzai, migrationText } from "../migration/yunzai.js"

const BasePlugin = globalThis.plugin
let running = false

export class LotusYunzaiMigration extends BasePlugin {
  constructor() {
    super({ name: migrationText("name"), dsc: migrationText("name"), event: "message", priority: -Infinity,
      rule: [{ reg: "^#迁移荷花云崽$", fnc: "migrate", permission: "master" }] })
  }

  async migrate() {
    if (this.e?.isMaster !== true) { await this.e.reply(migrationText("master")); return true }
    if (running) { await this.e.reply(migrationText("busy")); return true }
    running = true
    try {
      await this.e.reply(migrationText("begin"))
      await migrateYunzai({ requestedBy: this.e.user_id, onStep: message => this.e.reply(message) })
    } catch (error) {
      globalThis.logger?.error?.(`${migrationText("failed")} ${error.migrationState || ""}`)
      await this.e.reply(error.migrationState ? `${error.message}\n${error.migrationState}` : error.message)
    } finally { running = false }
    return true
  }
}
