import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export interface StoredKey {
  account_id: string;
  public_key: string;
  private_key: string;
}

/**
 * Keys for accounts this project creates live in `.data/keys/<network>/<account>.json`
 * (gitignored). The parent account's key is read from the near-cli legacy keychain.
 */
export class KeyStore {
  constructor(private readonly network: string) {}

  private localPath(account: string): string {
    return path.join(DATA_DIR, "keys", this.network, `${account}.json`);
  }

  private cliPath(account: string): string {
    return path.join(os.homedir(), ".near-credentials", this.network, `${account}.json`);
  }

  get(account: string, override?: string): string {
    if (override) return override;
    for (const p of [this.localPath(account), this.cliPath(account)]) {
      if (fs.existsSync(p)) {
        const k = JSON.parse(fs.readFileSync(p, "utf8")) as StoredKey;
        return k.private_key;
      }
    }
    throw new Error(`no key for ${account}: expected ${this.localPath(account)} or ${this.cliPath(account)}`);
  }

  has(account: string): boolean {
    return fs.existsSync(this.localPath(account)) || fs.existsSync(this.cliPath(account));
  }

  save(account: string, publicKey: string, privateKey: string): void {
    const p = this.localPath(account);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ account_id: account, public_key: publicKey, private_key: privateKey }, null, 2), {
      mode: 0o600,
    });
  }
}
