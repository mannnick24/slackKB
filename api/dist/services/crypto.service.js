import crypto from "node:crypto";
import { config } from "../config.js";
export class CryptoService {
    key;
    constructor() {
        const key = Buffer.from(config.encKeyB64, "base64");
        if (key.length !== 32) {
            throw new Error("APP_ENC_KEY_B64 must decode to 32 bytes");
        }
        this.key = key;
    }
    sealJson(obj) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
        const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const sealed = {
            v: 1,
            alg: "AES-256-GCM",
            ivB64: iv.toString("base64"),
            tagB64: tag.toString("base64"),
            ctB64: ct.toString("base64"),
        };
        return Buffer.from(JSON.stringify(sealed), "utf8").toString("base64");
    }
    openJson(sealedB64) {
        const raw = Buffer.from(sealedB64, "base64").toString("utf8");
        const sealed = JSON.parse(raw);
        if (sealed.v !== 1 || sealed.alg !== "AES-256-GCM") {
            throw new Error("Unsupported sealed blob format");
        }
        const iv = Buffer.from(sealed.ivB64, "base64");
        const tag = Buffer.from(sealed.tagB64, "base64");
        const ct = Buffer.from(sealed.ctB64, "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return JSON.parse(pt.toString("utf8"));
    }
}
