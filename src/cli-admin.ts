import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  addAccount,
  bindCloudflareEmail,
  deleteAccount,
  ensureLocalAdminToken,
  listAccounts,
  setAccountRole
} from "./auth.js";

function defaultStateRoot(): string {
  return resolve(process.env.MEMHUB_STATE_ROOT ?? join(homedir(), ".memmy", "memhub"));
}

function stateRootFromArgs(argv: string[]): { stateRoot: string; args: string[] } {
  let stateRoot = defaultStateRoot();
  const args = [...argv];
  for (let i = 0; i < args.length;) {
    if (args[i] !== "--state-root") { i += 1; continue; }
    const value = args[i + 1];
    if (!value) throw new Error("--state-root requires a value");
    stateRoot = value;
    args.splice(i, 2);
  }
  return { stateRoot, args };
}

export async function runAdminTokenCommand(argv: string[]): Promise<void> {
  const { stateRoot, args } = stateRootFromArgs(argv);
  const action = args[0] ?? "show";
  if (action !== "show" && action !== "rotate") throw new Error("admin-token supports show or rotate");
  process.stdout.write(await ensureLocalAdminToken(stateRoot, action === "rotate") + "\n");
}

export async function runAccountCommand(argv: string[]): Promise<void> {
  const { stateRoot, args } = stateRootFromArgs(argv);
  const action = args[0];
  if (action === "list") {
    process.stdout.write(JSON.stringify(await listAccounts(stateRoot), null, 2) + "\n");
    return;
  }
  if (action === "add") {
    const username = args[1];
    if (!username) throw new Error("account add requires username");
    process.stdout.write(JSON.stringify(await addAccount(stateRoot, username, args[2]), null, 2) + "\n");
    return;
  }
  if (action === "bind-email") {
    if (!args[1] || !args[2]) throw new Error("account bind-email requires username and email");
    await bindCloudflareEmail(stateRoot, args[1], args[2]);
    process.stdout.write("email bound\n");
    return;
  }
  if (action === "role") {
    if (!args[1] || (args[2] !== "admin" && args[2] !== "user")) {
      throw new Error("account role requires username/account_id/email and admin|user");
    }
    await setAccountRole(stateRoot, args[1], args[2]);
    process.stdout.write("account role updated\n");
    return;
  }
  if (action === "delete") {
    if (!args[1]) throw new Error("account delete requires username");
    await deleteAccount(stateRoot, args[1]);
    process.stdout.write("account deleted; memory/project data preserved\n");
    return;
  }
  throw new Error(`unknown account action: ${action ?? "<missing>"}`);
}
