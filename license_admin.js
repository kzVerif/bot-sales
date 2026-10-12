import "dotenv/config";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

// ==========================================
// 1. Configuration
// ==========================================
// ระบบจัดการ License Key (พอร์ตมาจาก admin_keys.py) — index.js เป็นตัวเรียกใช้ ห้ามให้ลูกค้าเข้าถึง
// .env:  SUPABASE_URL=https://xxxx.supabase.co   (ADMIN_IDS=id1,id2 ถ้ามีแอดมินเพิ่ม)
// secret key (sb_secret_...) อยู่ใน admin_secret.txt หรือ env SUPABASE_SECRET_KEY
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SECRET_FILE = path.join(BASE_DIR, "admin_secret.txt");
const OWNER_ID = "472356060632580097";
const ADMIN_IDS = new Set([
  OWNER_ID,
  ...(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

// ---- แจ้งเตือนเวอร์ชันใหม่ผ่าน Webhook (ใส่หลายห้องคั่นด้วยคอมมา, ห้องแจ้งอัปเดตจะแท็กห้องโหลดในเซิร์ฟเดียวกันให้เอง) ----
// RELEASE_TEST_MODE=0 เท่านั้นถึงจะบันทึกลง DB จริง — ค่าอื่น/ไม่ตั้ง = โหมดทดสอบ (ส่ง webhook อย่างเดียว ไม่แตะ DB)
const RELEASE_TEST_MODE = (process.env.RELEASE_TEST_MODE ?? "1").trim() !== "0";
const splitList = (value) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);
const UPDATE_WEBHOOKS = splitList(process.env.RELEASE_WEBHOOKS_UPDATE);
const DOWNLOAD_WEBHOOKS = splitList(process.env.RELEASE_WEBHOOKS_DOWNLOAD);
const TEST_WEBHOOK = (process.env.RELEASE_TEST_WEBHOOK || "").trim(); // ตั้งไว้ = โหมดทดสอบส่งทุกข้อความไปห้องนี้ห้องเดียว
const APP_NAME = process.env.RELEASE_APP_NAME || "Auto Post FB";

// ---- ไฟล์อัปเดต: รับได้เฉพาะ release ใน repo นี้ (ห้ามเปิดให้ใส่ URL เอง — โปรแกรมลูกค้าติดตั้งทุกไฟล์ที่ hash ตรง) ----
const RELEASE_REPO = "kzVerif/autopost-release";
const assetName = (version) => `AutoPost-v${version}.zip`;
// tag บน GitHub มีทั้งแบบ v1.3.3 และ 1.3.3 — ลิงก์ใช้ tag ที่เจอจริง
const releaseUrl = (version, tag = `v${version}`) => `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${assetName(version)}`;

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim(); // ไม่บังคับ: token read-only ได้ 5,000 ครั้ง/ชม. (ไม่ใส่ = 60)
const AUDIT_CHANNEL_ID = (process.env.ADMIN_LOG_CHANNEL_ID || "").trim(); // ช่องแอดมินสำหรับ audit log ทุกการเขียน app_info
const SECRET_ZIP_FILES = new Set(["config.json", "license.key", "admin_secret.txt"]);
const CONFIRM_TTL_MS = 5 * 60_000; // ปุ่มยืนยันหมดอายุใน 5 นาที

const KEY_ALPHABET ="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ตัด 0/O/1/I ที่อ่านสับสน
// แพ็กเกจ (ชื่อ/จำนวนบัญชี/ฟีเจอร์) อ่านจากตาราง plans ใน Supabase — แก้ที่ DB ได้เลยไม่ต้องแก้โค้ด
const UNLIMITED_ACCOUNTS = 9999; // max_accounts สูงสุดที่ schema ยอมรับ = ไม่จำกัด
const FEATURE_LABELS = {
  post: "โพสต์",
  comment: "คอมเมนต์",
  post_links: "โพสต์ลิงก์",
  check_links: "เช็คลิงก์",
  joined_groups: "กลุ่มที่เข้าร่วม",
  discord: "แจ้งเตือน Discord",
  like: "กดไลก์",
};
const EVENT_LABELS = {
  created: "🆕 สร้างคีย์",
  activated: "▶️ เริ่มใช้งานครั้งแรก",
  device_bound: "💻 ผูกเครื่องใหม่",
  extended: "⏳ ต่ออายุ",
  plan_changed: "📦 เปลี่ยนแพ็กเกจ",
  features_changed: "✨ เปลี่ยนฟีเจอร์เสริม",
  hwid_reset: "🔓 ปลดเครื่อง",
  revoked: "⛔ ยกเลิกคีย์",
  restored: "♻️ เปิดใช้อีกครั้ง",
};
const LEVELS = { info: "ทั่วไป", warn: "เตือน", critical: "สำคัญมาก" };
const PAGE_SIZE = 10;
const MAX_GEN = 25;
const EPHEMERAL = MessageFlags.Ephemeral;
const COLORS = { info: 0x5865f2, success: 0x57f287, warning: 0xfee75c, error: 0xed4245, muted: 0x4f545c };

/** ข้อผิดพลาดที่แสดงให้แอดมินเห็นได้ตรงๆ */
class AdminError extends Error {}

// ==========================================
// 2. Supabase / License helpers
// ==========================================
let cachedSecret = null;
function loadSecret() {
  if (cachedSecret) return cachedSecret;
  let secret = (process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!secret && existsSync(SECRET_FILE)) secret = readFileSync(SECRET_FILE, "utf-8").trim();
  if (!secret) throw new AdminError("ไม่พบ secret key — ใส่ sb_secret_... ไว้ใน admin_secret.txt หรือ env SUPABASE_SECRET_KEY");
  return (cachedSecret = secret);
}

async function api(method, query, body, prefer) {
  if (!SUPABASE_URL) throw new AdminError("ยังไม่ได้ตั้ง SUPABASE_URL ในไฟล์ .env");
  const secret = loadSecret();
  const headers = {
    apikey: secret,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "autopost-fb-admin-bot/1.0",
  };
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AdminError(`เชื่อมต่อ Supabase ไม่ได้: ${err.message}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    const detail = raw.slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new AdminError("Supabase ปฏิเสธ — secret key ผิดหรือหมดอายุ (ตรวจ admin_secret.txt / SUPABASE_SECRET_KEY)");
    }
    if (/PGRST204|42703/.test(detail) && detail.includes("sha256")) {
      throw new AdminError("ตาราง app_info ยังไม่มีคอลัมน์ sha256 — รัน schema.sql (หรือ supabase/auto_update.sql) ใน SQL Editor ก่อน");
    }
    // PGRST205 = ไม่มีตาราง, 42703/PGRST204 = ไม่มีคอลัมน์ → ฐานข้อมูลยังเป็นโครงสร้างเก่า
    if (/PGRST205|PGRST204|42703/.test(detail)) {
      throw new AdminError("โครงสร้างฐานข้อมูลไม่ตรงกับบอท — รันไฟล์ schema.sql ใน Supabase SQL Editor ก่อน");
    }
    if (detail.includes("licenses_plan_fkey")) throw new AdminError("ไม่พบแพ็กเกจนี้ในตาราง plans");
    if (detail.includes("licenses_max_accounts_check")) throw new AdminError(`จำนวนบัญชีต้องอยู่ระหว่าง 1–${UNLIMITED_ACCOUNTS}`);
    throw new AdminError(`Supabase ตอบกลับ HTTP ${res.status}: ${detail}`);
  }
  return raw ? JSON.parse(raw) : null;
}

const normalizeKey = (key) => String(key).replace(/\s+/g, "").toUpperCase();

function newKey() {
  const group = () => Array.from({ length: 4 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join("");
  return `APF-${group()}-${group()}-${group()}-${group()}`;
}

function parseDuration(text) {
  const match = String(text).trim().toLowerCase().match(/^(\d+)\s*([hdw])$/);
  if (!match || Number(match[1]) <= 0) throw new AdminError(`ระยะเวลาไม่ถูกต้อง: ${text} (ใช้เช่น 12h, 1d, 7d, 2w)`);
  return Number(match[1]) * { h: 1, d: 24, w: 24 * 7 }[match[2]];
}

function fmtHours(hours) {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days && rest) return `${days} วัน ${rest} ชม.`;
  return days ? `${days} วัน` : `${rest} ชม.`;
}

/** เวลาแบบ Discord timestamp — แสดงตามเขตเวลาของคนดูเอง */
function fmtTs(value) {
  if (!value) return "-";
  const unix = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${unix}:f> (<t:${unix}:R>)`;
}

/** แพ็กเกจทั้งหมดจากตาราง plans (Map code → แถว) เรียงตาม sort_order */
let planCache = null; // ไว้ใช้ตอนต้องเปิด modal ทันที (ห้ามรอ DB เกิน 3 วิ)
async function getPlans() {
  const rows = await api("GET", "plans?select=*&order=sort_order.asc");
  if (!rows?.length) throw new AdminError("ตาราง plans ว่าง — รันไฟล์ schema.sql ใน Supabase SQL Editor ก่อน");
  return (planCache = new Map(rows.map((p) => [p.code, p])));
}

const fmtAccounts = (n) => (n >= UNLIMITED_ACCOUNTS ? "ไม่จำกัดบัญชี" : `${n} บัญชี`);
const featureLabel = (f) => FEATURE_LABELS[f] ?? f;
const planName = (row, plans) => plans.get(row.plan)?.name ?? row.plan;
/** จำนวนบัญชีจริง: ค่าที่กำหนดเองในคีย์ (max_accounts) ก่อน ไม่งั้นใช้ของแพ็กเกจ — ตรงกับ check_license */
const accountsOf = (row, plans) => row.max_accounts ?? plans.get(row.plan)?.max_accounts ?? 1;
const planLabel = (row, plans) =>
  `${planName(row, plans)} · ${fmtAccounts(accountsOf(row, plans))}${row.max_accounts != null ? " (กำหนดเอง)" : ""}`;
/** ฟีเจอร์ทั้งหมดที่ใช้ได้ = ของแพ็กเกจ + ฟีเจอร์เสริมเฉพาะคีย์ */
const featuresOf = (row, plans) => [...new Set([...(plans.get(row.plan)?.features ?? []), ...(row.extra_features ?? [])])].sort();

/** บันทึกประวัติลง license_events (ไม่ให้การบันทึกพลาดไปขัดงานหลัก) */
async function logEvent(keys, type, detail = {}) {
  const rows = [keys].flat().map((key) => ({ key, type, detail }));
  try {
    await api("POST", "license_events", rows, "return=minimal");
  } catch (err) {
    console.error(`[License] บันทึกประวัติ ${type} ไม่สำเร็จ:`, err.message);
  }
}

function statusOf(row) {
  if (row.status === "revoked") return { text: "ยกเลิกแล้ว", color: COLORS.error, live: false };
  if (!row.activated_at) return { text: "ยังไม่ได้ใช้", color: COLORS.info, live: true };
  const leftMs = new Date(row.expires_at) - Date.now();
  if (leftMs <= 0) return { text: "หมดอายุ", color: COLORS.muted, live: false };
  const hours = Math.floor(leftMs / 3_600_000);
  const left = hours ? fmtHours(hours) : `${Math.floor(leftMs / 60_000)} นาที`;
  return { text: `ใช้งานอยู่ (เหลือ ${left})`, color: COLORS.success, live: true };
}

async function getRow(key) {
  const rows = await api("GET", `licenses?key=eq.${encodeURIComponent(normalizeKey(key))}&select=*`);
  if (!rows?.length) throw new AdminError(`ไม่พบคีย์ ${key}`);
  return rows[0];
}

async function updateRow(key, fields) {
  const rows = await api("PATCH", `licenses?key=eq.${encodeURIComponent(key)}`, fields, "return=representation");
  return rows[0];
}

/** รหัสแพ็กเกจที่พิมพ์มา → แถวในตาราง plans (คีย์ใหม่ต้องเป็นแพ็กเกจที่ยังเปิดขาย) */
function parsePlan(planText, plans) {
  const code = (planText || "basic").trim().toLowerCase();
  const plan = plans.get(code);
  const active = [...plans.values()].filter((p) => p.is_active).map((p) => p.code);
  if (!plan || !plan.is_active) throw new AdminError(`แพ็กเกจต้องเป็น ${active.join(" / ")}`);
  return plan;
}

/** จำนวนบัญชีที่กำหนดเอง — ว่าง = ใช้ตามแพ็กเกจ (null) */
function parseAccounts(accountsText) {
  const text = accountsText?.trim();
  if (!text) return null;
  const accounts = Number(text);
  if (!Number.isInteger(accounts) || accounts < 1 || accounts > UNLIMITED_ACCOUNTS) {
    throw new AdminError(`จำนวนบัญชีต้องอยู่ระหว่าง 1–${UNLIMITED_ACCOUNTS}`);
  }
  return accounts;
}

async function getAppInfo() {
  const rows = await api("GET", "app_info?id=eq.1&select=*");
  if (!rows?.length) throw new AdminError("ไม่พบข้อมูลใน app_info — รันไฟล์ schema.sql ใน Supabase SQL Editor ก่อน");
  return rows[0];
}

async function updateAppInfo(fields) {
  fields.updated_at = new Date().toISOString();
  return (await api("PATCH", "app_info?id=eq.1", fields, "return=representation"))[0];
}

function parseVersion(text) {
  const v = String(text).trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)*$/.test(v)) throw new AdminError(`เลขเวอร์ชันไม่ถูกต้อง: ${text} (ใช้เช่น 1.0.1)`);
  return v.split(".").map(Number);
}

function compareVersion(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** สิ่งที่ลูกค้าเห็นจริง (ผ่านฟังก์ชัน get_app_info) — คืน null ถ้าเรียกไม่ได้ */
async function getPublicAppInfo() {
  try {
    return await api("POST", "rpc/get_app_info", {});
  } catch {
    return null;
  }
}

/** โปรแกรมลูกค้า (1.3.2 ขึ้นไป) จะแสดงปุ่ม "อัปเดตตอนนี้" ก็ต่อเมื่อเงื่อนไขนี้ผ่าน */
const canAutoUpdate = (info) => /^https:\/\//.test(info.download_url || "") && /^[0-9a-f]{64}$/.test(info.sha256 || "");

// ==========================================
// 2b. ตรวจไฟล์ release บน GitHub (ขั้น 3–5 ในคู่มือระบบอัปเดต)
// ==========================================
/** หา asset AutoPost-v<เวอร์ชัน>.zip ใน release tag v<เวอร์ชัน> (ไม่เจอค่อยลอง tag <เวอร์ชัน> ไม่มี v) — คืน { asset, tag } */
async function findReleaseAsset(version) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "autopost-fb-admin-bot/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  for (const tag of [`v${version}`, version]) {
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${tag}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new AdminError(`เชื่อมต่อ GitHub ไม่ได้: ${err.message}`);
    }
    if (res.status === 404) continue;
    if (res.status === 403 || res.status === 429) {
      throw new AdminError("GitHub จำกัดจำนวนครั้งที่เรียก — รอสักครู่ หรือใส่ GITHUB_TOKEN (read-only) ใน .env");
    }
    if (!res.ok) throw new AdminError(`GitHub ตอบกลับ HTTP ${res.status}`);

    const release = await res.json();
    const asset = release.assets?.find((a) => a.name === assetName(version));
    if (!asset) throw new AdminError(`release ${tag} ไม่มีไฟล์ ${assetName(version)}`);
    if (asset.browser_download_url !== releaseUrl(version, tag)) {
      throw new AdminError(`ลิงก์ไฟล์ไม่ตรงรูปแบบที่กำหนด (${asset.browser_download_url})`);
    }
    return { asset, tag };
  }
  throw new AdminError(`ยังไม่มี release v${version} (หรือ ${version}) ใน ${RELEASE_REPO} — ให้ dev อัปโหลดก่อน`);
}

/** โหลด asset ลงไฟล์ชั่วคราวพร้อมคำนวณ SHA-256 — ผู้เรียกต้องลบ tmp เอง */
async function downloadAsset(asset) {
  const failed = (why) => new AdminError(`โหลดไฟล์ไม่ครบ — ลองใหม่ หรืออัปโหลดไฟล์ใหม่ทับ (${why})`);
  const tmp = path.join(os.tmpdir(), `autopost-release-${randomUUID()}.zip`);
  const hash = createHash("sha256");
  let bytes = 0;
  const out = createWriteStream(tmp);
  try {
    const res = await fetch(asset.browser_download_url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw failed(`HTTP ${res.status}`);
    for await (const chunk of res.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    await fs.rm(tmp, { force: true });
    throw err instanceof AdminError ? err : failed(err.message);
  }
  if (bytes !== asset.size) {
    await fs.rm(tmp, { force: true });
    throw failed(`ได้ ${bytes} จาก ${asset.size} ไบต์`);
  }
  return { tmp, sha256: hash.digest("hex"), bytes };
}

/** รายชื่อไฟล์ใน zip (อ่าน central directory เอง รองรับ ZIP64 — ไม่ต้องลงไลบรารีเพิ่ม) */
async function listZipEntries(file) {
  const bad = () => new AdminError("ไฟล์ zip เสียหายหรือไม่ใช่ zip");
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 22 + 65535 + 20); // EOCD + comment ยาวสุด + ZIP64 locator
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw bad();
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw bad();
      const z64 = Buffer.alloc(56);
      await fh.read(z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      if (z64.readUInt32LE(0) !== 0x06064b50) throw bad();
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size) throw bad();

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw bad();
      const utf8 = cd.readUInt16LE(p + 8) & 0x800;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.subarray(p + 46, p + 46 + nameLen).toString(utf8 ? "utf8" : "latin1"));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    await fh.close();
  }
}

/** ตรวจว่าเป็นชุดจาก build.py และไม่มีไฟล์ลับ/path อันตราย (โปรแกรมลูกค้าจะปฏิเสธ zip ที่ไม่มี exe/_internal) */
function checkZipEntries(names) {
  const paths = names.map((n) => n.replaceAll("\\", "/"));
  const unsafe = paths.find((n) => n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.split("/").includes(".."));
  if (unsafe) throw new AdminError(`zip มี path อันตราย (${unsafe}) — ห้ามปล่อย ให้ build ใหม่`);
  const secret = paths.find((n) => SECRET_ZIP_FILES.has(n.split("/").pop().toLowerCase()));
  if (secret) throw new AdminError(`พบไฟล์ลับในไฟล์ (${secret}) — ห้ามปล่อย ให้ลบ release นี้ทันที`);
  if (!paths.includes("AutoPost/AutoPost.exe") || !paths.some((n) => n.startsWith("AutoPost/_internal/"))) {
    throw new AdminError("ไฟล์ไม่ใช่ชุดจาก build.py (ไม่มี AutoPost/AutoPost.exe หรือ AutoPost/_internal/) — ลูกค้าจะอัปเดตไม่ได้");
  }
}

// ==========================================
// 2c. หน้ายืนยันก่อนเขียน app_info (กดได้เฉพาะคนสั่ง, หมดอายุ 5 นาที)
// ==========================================
const pendingWrites = new Map();

function addPending(userId, action) {
  const now = Date.now();
  for (const [id, p] of pendingWrites) if (p.expires < now) pendingWrites.delete(id);
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  pendingWrites.set(id, { ...action, userId, expires: now + CONFIRM_TTL_MS });
  return id;
}

/** ดึงงานที่รอยืนยัน — ต้องเรียกก่อน defer เพราะ error ตอบกลับเป็นข้อความใหม่ */
function getPending(interaction, id) {
  const p = pendingWrites.get(id);
  if (!p || p.expires < Date.now()) {
    pendingWrites.delete(id);
    throw new AdminError("หน้ายืนยันนี้หมดอายุแล้ว — เริ่มใหม่อีกครั้ง (ยังไม่ได้เขียนอะไร)");
  }
  if (p.userId !== interaction.user.id) throw new AdminError("ปุ่มนี้กดได้เฉพาะคนที่สั่งเท่านั้น");
  return p;
}

/** โพสต์ audit log ลงช่องแอดมิน: ใคร, เมื่อไหร่, ค่าเดิม → ค่าใหม่ (ไว้คืนค่าเมื่อกดผิด) */
async function auditLog(interaction, title, before, after) {
  if (!AUDIT_CHANNEL_ID) return "⚠️ ยังไม่ได้ตั้ง ADMIN_LOG_CHANNEL_ID ใน .env — ไม่ได้บันทึก audit log";
  const show = (v) => truncate(v == null ? "null" : String(v), 300).replaceAll("`", "ˋ");
  const changes = Object.keys(after)
    .filter((k) => k !== "updated_at" && (before[k] ?? null) !== (after[k] ?? null))
    .map((k) => `**${k}**\n\`${show(before[k])}\` ➜ \`${show(after[k])}\``);
  try {
    const channel = await interaction.client.channels.fetch(AUDIT_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle(`📝 ${title}`)
      .setColor(COLORS.muted)
      .setDescription(truncate(changes.join("\n\n") || "ไม่มีค่าที่เปลี่ยน", 4000))
      .addFields(
        { name: "โดย", value: `<@${interaction.user.id}> (\`${interaction.user.tag ?? interaction.user.id}\`)`, inline: true },
        { name: "เวลา", value: fmtTs(new Date()), inline: true },
      )
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return "📝 บันทึก audit log แล้ว";
  } catch (err) {
    return `⚠️ บันทึก audit log ไม่สำเร็จ: ${err.message}`;
  }
}

// ==========================================
// 3. Release webhooks
// ==========================================
const BULLET = "✦";

/** แปลง changelog หลายบรรทัดเป็น bullet */
function formatNotes(notes) {
  const lines = (notes || "").split("\n").map((l) => l.trim().replace(/^[-•*✦]\s*/, "")).filter(Boolean);
  if (!lines.length) return `${BULLET} ปรับปรุงประสิทธิภาพและแก้ไขข้อผิดพลาด`;
  return truncate(lines.map((l) => `${BULLET} ${l}`).join("\n"), 1500);
}

function releaseEmbeds(release, downloadChannelId, test) {
  const { version, previous, url, notes, force } = release;
  const now = Math.floor(Date.now() / 1000);
  const testLine = test ? ["-# 🧪 ข้อความทดสอบ — ยังไม่ได้ปล่อยเวอร์ชันนี้จริง", ""] : [];
  const kind = force ? "🔴 บังคับอัปเดต" : "🟢 แนะนำให้อัปเดต";
  const footer = { text: `${APP_NAME}${test ? " · โหมดทดสอบ" : ""}` };
  const downloadLink = `**[⬇️ คลิกเพื่อดาวน์โหลด v${version}](${url})**`;

  const update = new EmbedBuilder()
    .setColor(force ? 0xf04747 : 0x43b581)
    .setAuthor({ name: `${APP_NAME} · Update` })
    .setDescription(
      [
        ...testLine,
        `## 🚀 อัปเดตใหม่ v${version}`,
        previous ? `-# \`v${previous}\` ➜ \`v${version}\` · <t:${now}:D>` : `-# \`v${version}\` · <t:${now}:D>`,
        "",
        force
          ? "> 🔴 **บังคับอัปเดต**\n> เวอร์ชันเก่าจะกดเริ่มทำงานไม่ได้จนกว่าจะอัปเดต"
          : "> 🟢 **มีเวอร์ชันใหม่พร้อมให้อัปเดตแล้ว**\n> กด \"อัปเดตตอนนี้\" ในโปรแกรมได้เลย (เวอร์ชัน 1.3.2 ขึ้นไป)",
        "",
        "### 📝 มีอะไรเปลี่ยนบ้าง",
        formatNotes(notes),
        "",
        "### 📥 ดาวน์โหลด",
        downloadChannelId ? `ไปที่ห้อง <#${downloadChannelId}> ได้เลย` : downloadLink,
      ].join("\n"),
    )
    .setFooter(footer)
    .setTimestamp();

  const download = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: `${APP_NAME} · Download` })
    .setDescription(
      [
        ...testLine,
        `## 📦 ${APP_NAME} v${version}`,
        `-# พร้อมดาวน์โหลดแล้ว · <t:${now}:R>`,
        "",
        downloadLink,
        "",
        "### 🛠️ วิธีอัปเดต",
        "`1` เปิดโปรแกรม จะมีแถบแจ้งเวอร์ชันใหม่ (ภายใน 30 นาที หรือปิดแล้วเปิดโปรแกรมใหม่)",
        "`2` กด **อัปเดตตอนนี้** โปรแกรมจะโหลด ตรวจไฟล์ และติดตั้งให้เอง (ถ้ามีงานกำลังทำงานให้กดหยุดก่อน)",
        "`3` ใช้เวอร์ชันต่ำกว่า 1.3.2 หรืออัปเดตในโปรแกรมไม่ได้: กดปุ่มดาวน์โหลดด้านล่าง แล้วแตกไฟล์ทับของเดิม",
        "",
        "### 📝 มีอะไรใหม่",
        formatNotes(notes),
      ].join("\n"),
    )
    .addFields(
      { name: "เวอร์ชัน", value: `\`v${version}\``, inline: true },
      { name: "ประเภท", value: kind, inline: true },
      { name: "วันที่ปล่อย", value: `<t:${now}:D>`, inline: true },
    )
    .setFooter(footer)
    .setTimestamp();

  const buttons = [
    {
      type: 1,
      components: [{ type: 2, style: ButtonStyle.Link, label: `ดาวน์โหลด v${version}`, emoji: { name: "📥" }, url }],
    },
  ];
  return { update: update.toJSON(), download: download.toJSON(), buttons };
}

/** เซิร์ฟเวอร์/ห้องที่ webhook นี้ส่งไป ({ guild_id, channel_id }) — หาไม่เจอก็คืน {} */
async function webhookInfo(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

async function sendWebhook(url, payload) {
  const target = new URL(url);
  target.searchParams.set("wait", "true");
  target.searchParams.set("with_components", "true"); // ให้ webhook ธรรมดาส่งปุ่มลิงก์ได้

  const post = async (body) => {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
  };

  try {
    await post(payload);
  } catch (err) {
    if (!payload.components) throw err;
    await post({ ...payload, components: undefined }); // เผื่อ webhook ส่งปุ่มไม่ได้ — ส่งแบบไม่มีปุ่มแทน
  }
}

/** รอบแจ้งเตือนล่าสุด { release, failed: [url ห้องที่ส่งไม่สำเร็จ] } — ไว้ส่งซ้ำ (หายเมื่อรีสตาร์ทบอท) */
let lastAnnounce = null;

/** ส่งแจ้งเตือนเวอร์ชันใหม่ไปทุกห้อง (onlyUrls = ส่งเฉพาะห้องเหล่านี้) — คืนรายงานผลทีละห้อง */
async function announceRelease(release, test, onlyUrls = null) {
  const allRooms = [
    ...UPDATE_WEBHOOKS.map((url, i) => ({ kind: "update", label: `แจ้งอัปเดต #${i + 1}`, url })),
    ...DOWNLOAD_WEBHOOKS.map((url, i) => ({ kind: "download", label: `ห้องโหลด #${i + 1}`, url })),
  ];
  if (!allRooms.length) return ["⚠️ ยังไม่ได้ตั้ง RELEASE_WEBHOOKS_UPDATE / RELEASE_WEBHOOKS_DOWNLOAD ใน .env — ไม่ได้ส่งแจ้งเตือน"];
  const rooms = onlyUrls ? allRooms.filter((r) => onlyUrls.includes(r.url)) : allRooms;
  if (!rooms.length) return ["⚠️ ไม่มีห้องที่ต้องส่งซ้ำ"];

  // ห้องแจ้งอัปเดตจะแท็กห้องโหลดที่อยู่เซิร์ฟเวอร์เดียวกันเท่านั้น (แท็กข้ามเซิร์ฟ คนที่ไม่ได้อยู่จะเห็นเป็น #unknown)
  // เซิร์ฟไหนไม่มีห้องโหลด = ใส่ลิงก์ดาวน์โหลดตรงแทน
  // หาจากทุกห้อง (ไม่ใช่แค่ห้องที่ส่งรอบนี้) ตอนส่งซ้ำเฉพาะห้องอัปเดตจะได้แท็กห้องโหลดถูก
  const infos = await Promise.all(allRooms.map((room) => webhookInfo(room.url)));
  allRooms.forEach((room, i) => Object.assign(room, { guildId: infos[i].guild_id, channelId: infos[i].channel_id }));
  const downloadChannelIn = (guildId) =>
    guildId ? allRooms.find((r) => r.kind === "download" && r.guildId === guildId)?.channelId ?? null : null;

  const failed = [];
  const lines = await Promise.all(
    rooms.map(async (room) => {
      try {
        const { update, download, buttons } = releaseEmbeds(release, downloadChannelIn(room.guildId), test);
        const payload =
          room.kind === "update" ? { embeds: [update] } : { embeds: [download], components: buttons };
        const target = test && TEST_WEBHOOK ? TEST_WEBHOOK : room.url;
        await sendWebhook(target, payload);
        return `✅ ${room.label}${target === room.url ? "" : " (ส่งไปห้องทดสอบ)"}`;
      } catch (err) {
        failed.push(room.url);
        return `❌ ${room.label} — ${err.message}`;
      }
    }),
  );
  lastAnnounce = { release, failed };
  if (failed.length) lines.push("↪️ กด **📨 แจ้งเตือนซ้ำ** ในหน้าอัปเดต (หรือ /release-notify) เพื่อส่งซ้ำเฉพาะห้องที่ล้มเหลว");
  return lines;
}

// ==========================================
// 4. Embeds & Components
// ==========================================
const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

function statusEmbed(title, description, type = "info") {
  const icon = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" }[type];
  return new EmbedBuilder().setTitle(`${icon} ${title}`).setDescription(description).setColor(COLORS[type]);
}

const button = (id, label, style = ButtonStyle.Secondary, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
};

function panelMessage() {
  const embed = new EmbedBuilder()
    .setTitle("🔐 License Key Admin Panel")
    .setDescription(
      [
        "จัดการคีย์ลูกค้าจากปุ่มด้านล่าง (ใช้ได้เฉพาะแอดมิน — ผลลัพธ์จะเห็นแค่คนกด)",
        "",
        "➕ **สร้างคีย์** — สร้างคีย์ใหม่ เลือกระยะเวลา/แพ็กเกจ",
        "🔍 **จัดการคีย์** — ต่ออายุ, เปลี่ยนแพ็กเกจ, ปลดเครื่อง, ยกเลิก",
        "📋 **รายการคีย์** — ดูคีย์ทั้งหมด",
        "📢 **อัปเดต / ประกาศ** — แจ้งเวอร์ชันใหม่ หรือประกาศถึงลูกค้า",
      ].join("\n"),
    )
    .setColor(COLORS.info);
  const row = new ActionRowBuilder().addComponents(
    button("ak:gen", "สร้างคีย์", ButtonStyle.Success, "➕"),
    button("ak:find", "จัดการคีย์", ButtonStyle.Primary, "🔍"),
    button("ak:listopen", "รายการคีย์", ButtonStyle.Secondary, "📋"),
    button("ak:appopen", "อัปเดต / ประกาศ", ButtonStyle.Secondary, "📢"),
  );
  return { embeds: [embed], components: [row] };
}

function keyView(row, plans, notice) {
  const st = statusOf(row);
  const extras = row.extra_features ?? [];
  const embed = new EmbedBuilder()
    .setTitle("🔑 รายละเอียดคีย์")
    .setDescription(`${notice ? `${notice}\n` : ""}\`\`\`${row.key}\`\`\``)
    .setColor(st.color)
    .addFields(
      { name: "สถานะ", value: st.text, inline: true },
      { name: "ระยะเวลา", value: fmtHours(row.duration_hours), inline: true },
      { name: "แพ็กเกจ", value: planLabel(row, plans), inline: true },
      { name: "เริ่มใช้", value: fmtTs(row.activated_at), inline: true },
      { name: "หมดอายุ", value: fmtTs(row.expires_at), inline: true },
      { name: "ใช้ล่าสุด", value: fmtTs(row.last_seen_at), inline: true },
      { name: "ผูกเครื่อง", value: row.hwid ? `\`${row.hwid.slice(0, 16).toUpperCase()}\`` : "-", inline: true },
      { name: "หมายเหตุ", value: row.note || "-", inline: true },
      {
        name: "ฟีเจอร์ที่ใช้ได้",
        value: truncate(featuresOf(row, plans).map((f) => (extras.includes(f) ? `**${featureLabel(f)}** ✨` : featureLabel(f))).join(", ") || "-", 1024),
      },
    );

  const k = row.key;
  const actions = new ActionRowBuilder().addComponents(
    button(`ak:ext:${k}`, "ต่ออายุ", ButtonStyle.Success, "⏳"),
    button(`ak:hwid:${k}`, "ปลดเครื่อง", ButtonStyle.Primary, "💻").setDisabled(!row.hwid),
    button(`ak:note:${k}`, "หมายเหตุ", ButtonStyle.Secondary, "📝"),
    row.status === "revoked"
      ? button(`ak:restore:${k}`, "เปิดใช้อีกครั้ง", ButtonStyle.Success, "♻️")
      : button(`ak:revoke:${k}`, "ยกเลิกคีย์", ButtonStyle.Danger, "⛔"),
    button(`ak:view:${k}`, "รีเฟรช", ButtonStyle.Secondary, "🔄"),
  );
  const more = new ActionRowBuilder().addComponents(button(`ak:hist:${k}`, "ประวัติคีย์", ButtonStyle.Secondary, "📜"));

  // แพ็กเกจที่เลิกขายแล้วจะไม่ให้เลือกใหม่ แต่ยังโชว์ถ้าคีย์นี้ใช้อยู่
  const planOptions = [...plans.values()]
    .filter((p) => p.is_active || p.code === row.plan)
    .slice(0, 22)
    .map((p) => ({
      label: truncate(`${p.name} · ${fmtAccounts(p.max_accounts)}${p.is_active ? "" : " (เลิกขาย)"}`, 100),
      description: truncate(p.features.map(featureLabel).join(", ") || "ไม่มีฟีเจอร์", 100),
      value: `p:${p.code}`,
      default: p.code === row.plan && row.max_accounts == null,
    }));
  planOptions.push({ label: "กำหนดจำนวนบัญชีเอง…", value: "custom", emoji: "✏️", default: row.max_accounts != null });
  if (row.max_accounts != null) planOptions.push({ label: "ใช้จำนวนบัญชีตามแพ็กเกจ", value: "reset", emoji: "↩️" });
  const planSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ak:plan:${k}`)
      .setPlaceholder(`เปลี่ยนแพ็กเกจ (ตอนนี้: ${planLabel(row, plans)})`)
      .addOptions(planOptions),
  );

  const components = [actions, planSelect];
  // ฟีเจอร์เสริม = ฟีเจอร์ของแพ็กเกจอื่นที่แพ็กเกจของคีย์นี้ไม่มี (เลือกได้หลายอัน, เอาออกหมด = ไม่มีฟีเจอร์เสริม)
  const planFeatures = new Set(plans.get(row.plan)?.features ?? []);
  const extraChoices = [...new Set([...[...plans.values()].flatMap((p) => p.features), ...extras])]
    .filter((f) => !planFeatures.has(f))
    .slice(0, 25);
  if (extraChoices.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ak:feat:${k}`)
          .setPlaceholder("ฟีเจอร์เสริมเฉพาะคีย์นี้ (นอกเหนือจากแพ็กเกจ)")
          .setMinValues(0)
          .setMaxValues(extraChoices.length)
          .addOptions(extraChoices.map((f) => ({ label: featureLabel(f), description: f, value: f, default: extras.includes(f) }))),
      ),
    );
  }
  components.push(more);
  return { embeds: [embed], components };
}

/** ประวัติคีย์จากตาราง license_events (ล่าสุดก่อน) */
function historyView(key, events) {
  const lines = events.map((e) => {
    const d = e.detail ?? {};
    const extra =
      e.type === "extended" ? ` +${fmtHours(d.hours ?? 0)}` :
      e.type === "plan_changed" ? ` ${d.from ?? "?"} ➜ ${d.to ?? "?"}${d.max_accounts ? ` (${fmtAccounts(d.max_accounts)})` : ""}` :
      e.type === "features_changed" ? ` ${(d.extra_features ?? []).map(featureLabel).join(", ") || "ไม่มี"}` :
      d.hwid ? ` \`${String(d.hwid).toUpperCase()}\`` : "";
    return `${fmtTs(e.created_at)}\n└ ${EVENT_LABELS[e.type] ?? e.type}${extra}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("📜 ประวัติคีย์")
    .setDescription(truncate(`\`${key}\`\n\n${lines.join("\n") || "ยังไม่มีประวัติ"}`, 4000))
    .setColor(COLORS.info)
    .setFooter({ text: `แสดง ${events.length} รายการล่าสุด` });
  return { embeds: [embed] };
}

function listView(rows, plans, page, showAll) {
  const filtered = showAll ? rows : rows.filter((r) => statusOf(r).live);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const lines = slice.map((r) => {
    const note = r.note ? ` · ${truncate(r.note, 40)}` : "";
    return `\`${r.key}\` · ${fmtHours(r.duration_hours)} · ${planName(r, plans)}\n└ ${statusOf(r).text}${note}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`📋 รายการคีย์${showAll ? " (ทั้งหมด)" : ""}`)
    .setDescription(lines.join("\n") || "ไม่มีคีย์")
    .setColor(COLORS.info)
    .setFooter({
      text: `หน้า ${page + 1}/${pages} · ${filtered.length} คีย์${showAll ? "" : " (ซ่อนคีย์ที่หมดอายุ/ยกเลิก)"}`,
    });

  const all = showAll ? 1 : 0;
  const components = [
    new ActionRowBuilder().addComponents(
      button(`ak:list:${page - 1}:${all}`, "ก่อนหน้า", ButtonStyle.Secondary, "◀️").setDisabled(page === 0),
      button(`ak:list:${page + 1}:${all}`, "ถัดไป", ButtonStyle.Secondary, "▶️").setDisabled(page >= pages - 1),
      button(`ak:list:0:${1 - all}`, showAll ? "ซ่อนคีย์ที่หมดอายุ" : "แสดงทั้งหมด", ButtonStyle.Secondary, "👁️"),
    ),
  ];
  if (slice.length) {
    components.unshift(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ak:pick")
          .setPlaceholder("เลือกคีย์เพื่อจัดการ")
          .addOptions(
            slice.map((r) => ({
              label: r.key,
              value: r.key,
              description: truncate(`${statusOf(r).text}${r.note ? ` · ${r.note}` : ""}`, 100),
            })),
          ),
      ),
    );
  }
  return { embeds: [embed], components };
}

/** หน้า อัปเดต / ประกาศ — publicInfo = ผลจาก get_app_info (สิ่งที่ลูกค้าเห็นจริง) ไว้เตือนถ้าฟังก์ชันยังไม่คืน sha256 */
function appView(info, notice, publicInfo) {
  const level = LEVELS[info.announcement_level] ?? info.announcement_level;
  const warnings = [];
  if (publicInfo && !Object.hasOwn(publicInfo, "sha256")) {
    warnings.push("⚠️ get_app_info ยังไม่คืน sha256 — ลูกค้าจะอัปเดตในโปรแกรมไม่ได้ รัน schema.sql ใน SQL Editor");
  }
  if (publicInfo === null) warnings.push("⚠️ เรียก get_app_info ไม่ได้ — ลูกค้าอาจไม่เห็นข้อมูลอัปเดต");
  const autoUpdate = canAutoUpdate(info)
    ? `✅ ได้ (SHA-256 \`${info.sha256.slice(0, 12)}…\`)`
    : "❌ ไม่ได้ — ลูกค้าต้องกดดาวน์โหลดเอง (ไม่มี sha256)";
  const description = [notice, ...warnings].filter(Boolean).join("\n\n");

  const embed = new EmbedBuilder()
    .setTitle(`📢 อัปเดต / ประกาศ${RELEASE_TEST_MODE ? "  ·  🧪 โหมดทดสอบปล่อยเวอร์ชัน" : ""}`)
    .setDescription(truncate(description, 4000) || null)
    .setColor(RELEASE_TEST_MODE ? COLORS.warning : COLORS.info)
    .addFields(
      { name: "เวอร์ชันล่าสุด", value: String(info.latest_version), inline: true },
      { name: "ขั้นต่ำที่ใช้ได้", value: `${info.min_version} (ต่ำกว่านี้ = บังคับอัปเดต)`, inline: true },
      { name: "อัปเดตในโปรแกรม", value: autoUpdate, inline: true },
      { name: "ลิงก์ดาวน์โหลด", value: info.download_url || "-" },
      { name: "สิ่งที่เปลี่ยน", value: truncate(info.changelog || "-", 1024) },
      { name: "ประกาศ", value: info.announcement ? truncate(`${info.announcement}  [${level}]`, 1024) : "-" },
    )
    .setFooter({ text: `แก้ล่าสุด ${info.updated_at ? new Date(info.updated_at).toLocaleString("th-TH") : "-"} · ลูกค้าเห็นภายใน 30 นาที` });
  const row = new ActionRowBuilder().addComponents(
    button("ak:rel", RELEASE_TEST_MODE ? "ทดสอบปล่อยเวอร์ชัน" : "ปล่อยเวอร์ชันใหม่", ButtonStyle.Success, RELEASE_TEST_MODE ? "🧪" : "🚀"),
    button("ak:ann", "ประกาศ", ButtonStyle.Primary, "📣"),
    button("ak:annclr", "ลบประกาศ", ButtonStyle.Danger, "🗑️").setDisabled(!info.announcement),
    button("ak:resend", "แจ้งเตือนซ้ำ", ButtonStyle.Secondary, "📨"),
    button("ak:app", "รีเฟรช", ButtonStyle.Secondary, "🔄"),
  );
  return { embeds: [embed], components: [row] };
}

async function loadAppView(notice) {
  const [info, publicInfo] = await Promise.all([getAppInfo(), getPublicAppInfo()]);
  return appView(info, notice, publicInfo);
}

/** หน้ายืนยันก่อนเขียน app_info — งานบังคับอัปเดตต้องยืนยัน 2 ชั้น */
function confirmView(id, p) {
  if (p.kind === "resend") return resendConfirmView(id, p);
  const expires = `<t:${Math.floor(p.expires / 1000)}:R>`;
  const footer = { text: `กดได้เฉพาะคนที่สั่ง${RELEASE_TEST_MODE && p.kind === "release" ? " · 🧪 โหมดทดสอบ: จะไม่บันทึกลง DB" : ""}` };
  let embed;
  let confirmLabel = "ยืนยัน";
  let danger = false;

  if (p.kind === "release") {
    danger = p.force;
    const secondStep = p.force && p.forceAsked;
    embed = new EmbedBuilder()
      .setTitle(secondStep ? "⚠️ ยืนยันบังคับอัปเดตอีกครั้ง" : `🚀 ยืนยันปล่อยเวอร์ชัน v${p.version}`)
      .setColor(p.force ? COLORS.error : COLORS.success)
      .setDescription(
        [
          secondStep
            ? `ลูกค้าทุกคนที่ต่ำกว่า **v${p.version}** จะใช้งานไม่ได้จนกว่าจะอัปเดต\nถ้าเวอร์ชันใหม่มีบั๊ก ลูกค้าจะใช้งานไม่ได้ทั้งเวอร์ชันเก่าและใหม่`
            : `ตรวจไฟล์บน GitHub ผ่านแล้ว — ยังไม่ได้เขียนอะไรลง Supabase`,
          `หมดอายุ ${expires}`,
        ].join("\n"),
      )
      .addFields(
        { name: "เวอร์ชัน", value: `\`v${p.previous}\` ➜ \`v${p.version}\``, inline: true },
        { name: "ขนาด", value: `${(p.bytes / 1024 / 1024).toFixed(1)} MB`, inline: true },
        { name: "SHA-256", value: `\`${p.sha256.slice(0, 12)}…\``, inline: true },
        { name: "บังคับอัปเดต", value: p.force ? "🔴 ใช่ (ตั้ง min_version = เวอร์ชันนี้)" : "ไม่", inline: true },
        { name: "ไฟล์", value: `[${assetName(p.version)}](${releaseUrl(p.version, p.tag)})`, inline: true },
        { name: "สิ่งที่เปลี่ยน", value: truncate(p.notes || "-", 1024) },
      );
    confirmLabel = p.force ? (secondStep ? "ยืนยันบังคับอัปเดต" : "ถัดไป") : "ยืนยันปล่อยเวอร์ชัน";
  } else if (p.kind === "announce") {
    embed = new EmbedBuilder()
      .setTitle("📣 ยืนยันประกาศถึงลูกค้าทุกคน")
      .setColor(COLORS.warning)
      .setDescription(`แสดงเป็นแถบบนสุดในโปรแกรม (ลูกค้าเห็นภายใน 30 นาที)\nหมดอายุ ${expires}`)
      .addFields(
        { name: "ระดับ", value: `${p.level} (${LEVELS[p.level]})`, inline: true },
        { name: "ข้อความ", value: truncate(p.text, 1024) },
      );
  } else {
    embed = new EmbedBuilder()
      .setTitle("🗑️ ยืนยันลบประกาศ")
      .setColor(COLORS.warning)
      .setDescription(`ลูกค้าจะไม่เห็นแถบประกาศอีก\nหมดอายุ ${expires}`);
    danger = true;
  }
  embed.setFooter(footer);
  const row = new ActionRowBuilder().addComponents(
    button(`ak:cfm:${id}`, confirmLabel, danger ? ButtonStyle.Danger : ButtonStyle.Success, "✅"),
    button(`ak:cxl:${id}`, "ยกเลิก", ButtonStyle.Secondary, "✖️"),
  );
  return { embeds: [embed], components: [row] };
}

/** หน้ายืนยันแจ้งเตือนซ้ำ — เลือกส่งทุกห้อง หรือเฉพาะห้องที่รอบก่อนส่งไม่สำเร็จ */
function resendConfirmView(id, p) {
  const r = p.release;
  const test = RELEASE_TEST_MODE;
  const embed = new EmbedBuilder()
    .setTitle(`📨 แจ้งเตือนซ้ำ v${r.version}`)
    .setColor(COLORS.warning)
    .setDescription(
      [
        `ส่งประกาศเวอร์ชันนี้ไปห้องแจ้งอัปเดต (${UPDATE_WEBHOOKS.length} ห้อง) และห้องโหลด (${DOWNLOAD_WEBHOOKS.length} ห้อง) อีกรอบ`,
        p.failed.length
          ? `รอบก่อนส่งไม่สำเร็จ **${p.failed.length} ห้อง** — เลือก "เฉพาะห้องที่ล้มเหลว" กันห้องอื่นได้ข้อความซ้ำ`
          : "รอบก่อนไม่มีห้องที่ล้มเหลว (หรือบอทรีสตาร์ทไปแล้ว) — ห้องที่เคยได้รับแล้วจะได้ข้อความซ้ำ",
        `หมดอายุ <t:${Math.floor(p.expires / 1000)}:R>`,
      ].join("\n"),
    )
    .addFields(
      { name: "เวอร์ชัน", value: r.previous ? `\`v${r.previous}\` ➜ \`v${r.version}\`` : `\`v${r.version}\``, inline: true },
      { name: "ประเภท", value: r.force ? "🔴 บังคับอัปเดต" : "🟢 แนะนำให้อัปเดต", inline: true },
      { name: "ลิงก์", value: r.url },
    )
    .setFooter({ text: `กดได้เฉพาะคนที่สั่ง${test ? " · 🧪 โหมดทดสอบ: ส่งเป็นข้อความทดสอบ" : ""}` });
  const buttons = [button(`ak:cfm:${id}`, "ส่งทุกห้อง", ButtonStyle.Primary, "📨")];
  if (p.failed.length) buttons.push(button(`ak:cfmf:${id}`, `เฉพาะห้องที่ล้มเหลว (${p.failed.length})`, ButtonStyle.Success, "↪️"));
  buttons.push(button(`ak:cxl:${id}`, "ยกเลิก", ButtonStyle.Secondary, "✖️"));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

/** หน้าแจ้งว่าปล่อยเวอร์ชันไม่ผ่าน (ยังไม่เขียน Supabase) พร้อมปุ่มกลับ */
function releaseFailedView(message) {
  return {
    embeds: [statusEmbed("ปล่อยเวอร์ชันไม่สำเร็จ", `${message}\n\nยังไม่ได้เขียนอะไรลง Supabase`, "error")],
    components: [new ActionRowBuilder().addComponents(button("ak:app", "กลับหน้าอัปเดต", ButtonStyle.Secondary, "↩️"))],
  };
}

function modal(id, title, inputs) {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      inputs.map(({ id: inputId, label, placeholder, value, required = true, long = false, max }) => {
        const input = new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(label)
          .setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(required);
        if (placeholder) input.setPlaceholder(placeholder);
        if (value) input.setValue(value);
        if (max) input.setMaxLength(max);
        return new ActionRowBuilder().addComponents(input);
      }),
    );
}

const field = (interaction, id) => interaction.fields.getTextInputValue(id).trim();

// ==========================================
// 5. Interaction handlers
// ==========================================
async function loadKey(key) {
  const [row, plans] = await Promise.all([getRow(key), getPlans()]);
  return { row, plans };
}

async function handleGenSubmit(interaction) {
  const hours = parseDuration(field(interaction, "duration"));
  const accounts = parseAccounts(field(interaction, "accounts"));
  const count = Number(field(interaction, "count") || "1");
  if (!Number.isInteger(count) || count < 1 || count > MAX_GEN) throw new AdminError(`จำนวนคีย์ต้องอยู่ระหว่าง 1–${MAX_GEN}`);
  const note = field(interaction, "note") || null;

  await interaction.deferReply({ flags: EPHEMERAL });
  const plans = await getPlans();
  const plan = parsePlan(field(interaction, "plan"), plans);
  const rows = Array.from({ length: count }, () => ({
    key: newKey(),
    duration_hours: hours,
    note,
    plan: plan.code,
    max_accounts: accounts,
  }));
  const created = await api("POST", "licenses", rows, "return=representation");
  await logEvent(created.map((r) => r.key), "created", { plan: plan.code, duration_hours: hours, max_accounts: accounts });
  const notice = `✅ สร้างคีย์ ${fmtHours(hours)} แพ็กเกจ ${planLabel(created[0], plans)} แล้ว (เริ่มนับเวลาเมื่อลูกค้าใช้คีย์ครั้งแรก)`;

  if (created.length === 1) return interaction.editReply(keyView(created[0], plans, notice));
  const embed = statusEmbed(`สร้างคีย์ ${created.length} อัน`, `${notice}\n\`\`\`\n${created.map((r) => r.key).join("\n")}\n\`\`\``, "success");
  if (note) embed.addFields({ name: "หมายเหตุ", value: note });
  await interaction.editReply({ embeds: [embed] });
}

async function handleKeyAction(interaction, action, key) {
  // ปุ่มที่ต้องเปิด modal ต้องตอบทันที (ห้าม defer ก่อน)
  if (action === "ext") {
    return interaction.showModal(
      modal(`ak:extm:${key}`, "ต่ออายุคีย์", [{ id: "duration", label: "ระยะเวลาที่เพิ่ม (12h / 1d / 7d / 2w)", placeholder: "7d", max: 10 }]),
    );
  }
  if (action === "note") {
    const current = interaction.message.embeds[0]?.fields.find((f) => f.name === "หมายเหตุ")?.value;
    return interaction.showModal(
      modal(`ak:notem:${key}`, "แก้หมายเหตุ", [
        { id: "note", label: "หมายเหตุ (เว้นว่าง = ลบ)", value: current !== "-" ? current : undefined, required: false, max: 200 },
      ]),
    );
  }

  if (action === "hist") {
    await interaction.deferReply({ flags: EPHEMERAL });
    const k = normalizeKey(key);
    const events = await api("GET", `license_events?key=eq.${encodeURIComponent(k)}&select=*&order=created_at.desc&limit=15`);
    return interaction.editReply(historyView(k, events));
  }

  await interaction.deferUpdate();
  let { row, plans } = await loadKey(key);
  let notice;
  if (action === "hwid") {
    const oldHwid = row.hwid;
    row = await updateRow(row.key, { hwid: null });
    await logEvent(row.key, "hwid_reset", { hwid: oldHwid?.slice(0, 16) ?? null });
    notice = "✅ ปลดเครื่องแล้ว — ลูกค้าใส่คีย์เดิมในเครื่องใหม่ได้เลย (เวลาที่เหลือเดินต่อ)";
  } else if (action === "revoke") {
    row = await updateRow(row.key, { status: "revoked" });
    await logEvent(row.key, "revoked");
    notice = "⛔ ยกเลิกคีย์แล้ว — โปรแกรมลูกค้าจะหยุดภายใน 10 นาที";
  } else if (action === "restore") {
    row = await updateRow(row.key, { status: "active" });
    await logEvent(row.key, "restored");
    notice = "♻️ เปิดใช้คีย์อีกครั้งแล้ว";
  }
  await interaction.editReply(keyView(row, plans, notice));
}

async function handleKeyModal(interaction, action, key) {
  await interaction.deferUpdate();
  let { row, plans } = await loadKey(key);
  let notice;
  if (action === "extm") {
    const hours = parseDuration(field(interaction, "duration"));
    const fields = { duration_hours: row.duration_hours + hours };
    if (row.expires_at) {
      // หมดอายุไปแล้ว = นับต่อจากตอนนี้, ยังไม่หมด = บวกต่อจากวันหมดอายุเดิม
      const base = Math.max(new Date(row.expires_at).getTime(), Date.now());
      fields.expires_at = new Date(base + hours * 3_600_000).toISOString();
    }
    row = await updateRow(row.key, fields);
    await logEvent(row.key, "extended", { hours, expires_at: row.expires_at });
    notice = `✅ ต่ออายุ ${fmtHours(hours)} แล้ว`;
  } else if (action === "notem") {
    row = await updateRow(row.key, { note: field(interaction, "note") || null });
    notice = "✅ แก้หมายเหตุแล้ว";
  } else if (action === "accm") {
    const accounts = parseAccounts(field(interaction, "accounts"));
    if (accounts == null) throw new AdminError("กรุณาใส่จำนวนบัญชี");
    row = await updateRow(row.key, { max_accounts: accounts });
    await logEvent(row.key, "plan_changed", { from: row.plan, to: row.plan, max_accounts: accounts });
    notice = `✅ เปลี่ยนเป็น ${planLabel(row, plans)} แล้ว — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที`;
  }
  await interaction.editReply(keyView(row, plans, notice));
}

async function handlePlanSelect(interaction, key) {
  const choice = interaction.values[0];
  if (choice === "custom") {
    return interaction.showModal(
      modal(`ak:accm:${key}`, "กำหนดจำนวนบัญชีเอง", [
        { id: "accounts", label: `จำนวนบัญชีที่รันพร้อมกัน (1–${UNLIMITED_ACCOUNTS})`, placeholder: "10", max: 4 },
      ]),
    );
  }
  await interaction.deferUpdate();
  const { row: current, plans } = await loadKey(key);
  // เลือกแพ็กเกจ = ใช้จำนวนบัญชีตามแพ็กเกจนั้น (ล้างค่าที่กำหนดเองทิ้ง)
  const code = choice === "reset" ? current.plan : choice.slice(2);
  if (!plans.has(code)) throw new AdminError("ไม่พบแพ็กเกจนี้ในตาราง plans");
  const row = await updateRow(current.key, { plan: code, max_accounts: null });
  await logEvent(row.key, "plan_changed", { from: current.plan, to: code, max_accounts: null });
  await interaction.editReply(
    keyView(row, plans, `✅ เปลี่ยนเป็นแพ็กเกจ ${planLabel(row, plans)} แล้ว — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที`),
  );
}

async function handleFeatureSelect(interaction, key) {
  await interaction.deferUpdate();
  const { row: current, plans } = await loadKey(key);
  const extras = [...interaction.values].sort();
  const row = await updateRow(current.key, { extra_features: extras });
  await logEvent(row.key, "features_changed", { extra_features: extras, before: current.extra_features ?? [] });
  const notice = extras.length
    ? `✅ ตั้งฟีเจอร์เสริม: ${extras.map(featureLabel).join(", ")} — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที`
    : "✅ เอาฟีเจอร์เสริมออกทั้งหมดแล้ว (ใช้ตามแพ็กเกจ)";
  await interaction.editReply(keyView(row, plans, notice));
}

/** ขั้น 1–5 ของ release: ตรวจเลข → เทียบกับ app_info → หาไฟล์บน GitHub → โหลด+คำนวณ SHA-256 → ตรวจ zip → หน้ายืนยัน
 *  (ผู้เรียก defer ไว้แล้ว) ข้อไหนไม่ผ่าน = หยุดทันที ยังไม่เขียนอะไรลง Supabase */
async function prepareRelease(interaction, { version, notes, force }) {
  try {
    version = version.trim().replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new AdminError("เลขเวอร์ชันผิดรูปแบบ — ใส่เลขแบบ 1.3.3");
    const current = await getAppInfo();
    if (compareVersion(version, current.latest_version) < 0) {
      throw new AdminError(`${version} เก่ากว่าเวอร์ชันที่ประกาศไว้ (${current.latest_version}) — ห้ามถอยเลข ให้ release เลขที่สูงกว่า`);
    }

    await interaction.editReply({
      embeds: [statusEmbed("กำลังตรวจไฟล์", `กำลังโหลด ${assetName(version)} จาก GitHub เพื่อคำนวณ SHA-256 และตรวจข้างใน zip (ไฟล์ราว 50 MB อาจใช้เวลาสักครู่)…`)],
      components: [],
    });
    const { asset, tag } = await findReleaseAsset(version);
    const { tmp, sha256, bytes } = await downloadAsset(asset);
    try {
      checkZipEntries(await listZipEntries(tmp));
    } finally {
      await fs.rm(tmp, { force: true });
    }

    const action = { kind: "release", version, tag, previous: current.latest_version, notes: notes || null, force, sha256, bytes };
    const id = addPending(interaction.user.id, action);
    await interaction.editReply(confirmView(id, pendingWrites.get(id)));
  } catch (err) {
    if (!(err instanceof AdminError)) throw err;
    await interaction.editReply(releaseFailedView(err.message));
  }
}

function prepareAnnounce(interaction, text, levelText) {
  const level = (levelText || "info").trim().toLowerCase();
  if (!(level in LEVELS)) throw new AdminError("ระดับต้องเป็น info / warn / critical");
  if (!text.trim()) throw new AdminError("กรุณาใส่ข้อความประกาศ");
  const id = addPending(interaction.user.id, { kind: "announce", text: text.trim(), level });
  return confirmView(id, pendingWrites.get(id));
}

function prepareAnnounceClear(interaction) {
  const id = addPending(interaction.user.id, { kind: "announce_clear" });
  return confirmView(id, pendingWrites.get(id));
}

/** กดยืนยันแล้ว → เขียน app_info ด้วย PATCH ครั้งเดียว → audit log → ประกาศในช่องลูกค้า */
async function executePending(interaction, p) {
  if (p.kind === "resend") {
    // แจ้งเตือนซ้ำไม่เขียน app_info — แค่ส่ง webhook
    const lines = await announceRelease(p.release, RELEASE_TEST_MODE, p.onlyFailed ? p.failed : null);
    const scope = p.onlyFailed ? "เฉพาะห้องที่ล้มเหลว" : "ทุกห้อง";
    return interaction.editReply(await loadAppView(`📨 แจ้งเตือนซ้ำ v${p.release.version} (${scope})\n${lines.join("\n")}`));
  }
  const before = await getAppInfo();
  let info = before;
  let fields;
  let notice;

  if (p.kind === "release") {
    // เผื่อมีคนปล่อยเวอร์ชันสูงกว่าตัดหน้าระหว่างรอยืนยัน
    if (compareVersion(p.version, before.latest_version) < 0) {
      throw new AdminError(`${p.version} เก่ากว่าเวอร์ชันที่ประกาศไว้ (${before.latest_version}) แล้ว — ยกเลิกการปล่อย`);
    }
    fields = { latest_version: p.version, download_url: releaseUrl(p.version, p.tag), sha256: p.sha256, changelog: p.notes };
    if (p.force) fields.min_version = p.version;
    const release = { version: p.version, previous: before.latest_version, url: releaseUrl(p.version, p.tag), notes: p.notes, force: p.force };

    if (RELEASE_TEST_MODE) {
      notice = `🧪 **โหมดทดสอบ** — ไฟล์ผ่านการตรวจ (SHA-256 \`${p.sha256.slice(0, 12)}…\`) ส่งแจ้งเตือน v${p.version} แล้ว แต่ยังไม่ได้บันทึกลง DB`;
    } else {
      info = await updateAppInfo(fields);
      notice =
        `🚀 ปล่อยเวอร์ชัน ${p.version} แล้ว — ลูกค้าจะเห็นภายใน 30 นาที และกด "อัปเดตตอนนี้" ได้ (เวอร์ชัน 1.3.2 ขึ้นไป)` +
        (p.force ? "\n🔴 เวอร์ชันเก่าจะใช้งานไม่ได้จนกว่าจะอัปเดต" : "");
      notice += `\n${await auditLog(interaction, `ปล่อยเวอร์ชัน v${p.version}${p.force ? " (บังคับอัปเดต)" : ""}`, before, info)}`;
    }
    notice += `\n\n**แจ้งเตือนห้อง Discord**\n${(await announceRelease(release, RELEASE_TEST_MODE)).join("\n")}`;
  } else if (p.kind === "announce") {
    // announcement_at ต้องใหม่ทุกครั้ง ไม่งั้นลูกค้าที่เคยกดซ่อนประกาศก่อนหน้าจะไม่เห็น
    fields = { announcement: p.text, announcement_level: p.level, announcement_at: new Date().toISOString() };
    info = await updateAppInfo(fields);
    notice = `📣 ประกาศแล้ว — โปรแกรมลูกค้าจะเห็นภายใน 30 นาที\n${await auditLog(interaction, "ตั้งประกาศในโปรแกรม", before, info)}`;
  } else {
    fields = { announcement: null, announcement_at: null };
    info = await updateAppInfo(fields);
    notice = `🗑️ ลบประกาศแล้ว\n${await auditLog(interaction, "ลบประกาศในโปรแกรม", before, info)}`;
  }
  await interaction.editReply(appView(info, notice, await getPublicAppInfo()));
}

/** เวอร์ชันที่จะแจ้งเตือนซ้ำ: รอบล่าสุดที่จำไว้ (รู้เวอร์ชันก่อนหน้า + ใช้ได้ในโหมดทดสอบที่ไม่บันทึก DB) ถ้ายังเป็นตัวล่าสุด
 *  ไม่งั้น (เช่นรีสตาร์ทบอทแล้ว) สร้างจาก app_info */
async function prepareResend(interaction) {
  const info = await getAppInfo();
  let release;
  let failed = [];
  if (lastAnnounce && compareVersion(lastAnnounce.release.version, info.latest_version) >= 0) {
    ({ release, failed } = lastAnnounce);
  } else {
    if (!info.download_url) throw new AdminError("ยังไม่มีเวอร์ชันที่ปล่อยไว้ใน app_info — ไม่มีอะไรให้แจ้งเตือนซ้ำ");
    release = {
      version: info.latest_version,
      previous: null,
      url: info.download_url,
      notes: info.changelog,
      force: compareVersion(info.min_version, info.latest_version) >= 0,
    };
  }
  const id = addPending(interaction.user.id, { kind: "resend", release, failed });
  return confirmView(id, pendingWrites.get(id));
}

async function handleConfirm(interaction, id, { onlyFailed = false } = {}) {
  const p = getPending(interaction, id);
  if (p.kind === "resend") p.onlyFailed = onlyFailed;
  if (p.kind === "release" && p.force && !p.forceAsked) {
    p.forceAsked = true; // บังคับอัปเดต = ถามยืนยันอีกชั้น
    return interaction.update(confirmView(id, p));
  }
  pendingWrites.delete(id); // กดซ้ำไม่ได้
  await interaction.deferUpdate();
  try {
    await executePending(interaction, p);
  } catch (err) {
    if (!(err instanceof AdminError)) throw err;
    await interaction.editReply(releaseFailedView(err.message));
  }
}

async function handleAppModal(interaction, id) {
  await interaction.deferUpdate();
  if (id === "ak:relm") {
    return prepareRelease(interaction, {
      version: field(interaction, "version"),
      notes: field(interaction, "notes"),
      force: /^(y|yes|ใช่|1|true)$/i.test(field(interaction, "force")),
    });
  }
  await interaction.editReply(prepareAnnounce(interaction, field(interaction, "text"), field(interaction, "level")));
}

async function handleButton(interaction) {
  const id = interaction.customId;
  const [, action, ...rest] = id.split(":");

  switch (action) {
    case "gen": {
      // ต้องเปิด modal ทันที จึงใช้รายชื่อแพ็กเกจที่โหลดไว้ล่าสุด (ตรวจจริงกับ DB ตอนกดยืนยัน)
      const active = planCache ? [...planCache.values()].filter((p) => p.is_active).map((p) => p.code) : [];
      const planHint = active.length ? active.join(" / ") : "basic / plus / pro";
      return interaction.showModal(
        modal("ak:genm", "สร้างคีย์ใหม่", [
          { id: "duration", label: "ระยะเวลา (12h / 1d / 7d / 30d / 2w)", placeholder: "30d", max: 10 },
          { id: "plan", label: truncate(`แพ็กเกจ (${planHint})`, 45), value: active[0] ?? "basic", max: 30 },
          { id: "accounts", label: "จำนวนบัญชีเอง (เว้นว่าง = ตามแพ็กเกจ)", required: false, max: 4 },
          { id: "count", label: `จำนวนคีย์ (1–${MAX_GEN})`, value: "1", max: 2 },
          { id: "note", label: "หมายเหตุ เช่น ชื่อลูกค้า", required: false, max: 200 },
        ]),
      );
    }
    case "find":
      return interaction.showModal(
        modal("ak:findm", "จัดการคีย์", [{ id: "key", label: "License Key", placeholder: "APF-XXXX-XXXX-XXXX-XXXX", max: 40 }]),
      );
    case "listopen": {
      await interaction.deferReply({ flags: EPHEMERAL });
      const [rows, plans] = await Promise.all([api("GET", "licenses?select=*&order=created_at.desc"), getPlans()]);
      return interaction.editReply(listView(rows, plans, 0, false));
    }
    case "list": {
      await interaction.deferUpdate();
      const [rows, plans] = await Promise.all([api("GET", "licenses?select=*&order=created_at.desc"), getPlans()]);
      return interaction.editReply(listView(rows, plans, Number(rest[0]), rest[1] === "1"));
    }
    case "appopen":
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(await loadAppView());
    case "app":
      await interaction.deferUpdate();
      return interaction.editReply(await loadAppView());
    case "annclr":
      return interaction.update(prepareAnnounceClear(interaction));
    case "cfm":
      return handleConfirm(interaction, rest[0]);
    case "cfmf":
      return handleConfirm(interaction, rest[0], { onlyFailed: true });
    case "resend":
      await interaction.deferUpdate();
      try {
        return await interaction.editReply(await prepareResend(interaction));
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        return interaction.editReply(await loadAppView(`❌ ${err.message}`));
      }
    case "cxl":
      getPending(interaction, rest[0]);
      pendingWrites.delete(rest[0]);
      await interaction.deferUpdate();
      return interaction.editReply(await loadAppView("✖️ ยกเลิกแล้ว — ยังไม่ได้เขียนอะไรลง Supabase"));
    case "rel":
      return interaction.showModal(
        modal("ak:relm", RELEASE_TEST_MODE ? "ทดสอบปล่อยเวอร์ชัน (ไม่บันทึก DB)" : "ปล่อยเวอร์ชันใหม่", [
          { id: "version", label: "เลขเวอร์ชัน (ต้องมี release บน GitHub แล้ว)", placeholder: "1.3.3", max: 20 },
          { id: "notes", label: "สิ่งที่เปลี่ยนในเวอร์ชันนี้", required: false, long: true, max: 1000 },
          { id: "force", label: "บังคับอัปเดต? (ใช่ / ไม่)", value: "ไม่", max: 5 },
        ]),
      );
    case "ann":
      return interaction.showModal(
        modal("ak:annm", "ประกาศถึงลูกค้าทุกคน", [
          { id: "text", label: "ข้อความประกาศ", long: true, max: 1000 },
          { id: "level", label: "ระดับ (info=ฟ้า / warn=ส้ม / critical=แดง)", value: "info", max: 10 },
        ]),
      );
    case "view": {
      await interaction.deferUpdate();
      const { row, plans } = await loadKey(rest[0]);
      return interaction.editReply(keyView(row, plans));
    }
    default:
      return handleKeyAction(interaction, action, rest[0]);
  }
}

async function handleModal(interaction) {
  const id = interaction.customId;
  if (id === "ak:genm") return handleGenSubmit(interaction);
  if (id === "ak:findm") {
    await interaction.deferReply({ flags: EPHEMERAL });
    const { row, plans } = await loadKey(field(interaction, "key"));
    return interaction.editReply(keyView(row, plans));
  }
  if (id === "ak:relm" || id === "ak:annm") return handleAppModal(interaction, id);
  const [, action, key] = id.split(":");
  return handleKeyModal(interaction, action, key);
}

async function handleSelect(interaction) {
  if (interaction.customId === "ak:pick") {
    await interaction.deferReply({ flags: EPHEMERAL });
    const { row, plans } = await loadKey(interaction.values[0]);
    return interaction.editReply(keyView(row, plans));
  }
  const [, kind, key] = interaction.customId.split(":");
  if (kind === "feat") return handleFeatureSelect(interaction, key);
  return handlePlanSelect(interaction, key);
}

// ==========================================
// 6. Exports (ใช้จาก index.js)
// ==========================================
export const isAdmin = (userId) => ADMIN_IDS.has(userId);

/** slash command ของระบบคีย์: /keypanel, /key (index.js เป็นคนลงทะเบียนคำสั่ง) */
export const licenseCommands = {
  async keypanel(interaction) {
    await interaction.reply({ content: "โพสต์แผงจัดการ License Key แล้ว ✅", flags: EPHEMERAL });
    await interaction.channel.send(panelMessage());
  },

  // ---- ระบบอัปเดตโปรแกรม (ทำแบบเดียวกับปุ่มในแผง "อัปเดต / ประกาศ") ----
  async "app-info"(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL });
    await interaction.editReply(await loadAppView());
  },

  async release(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL }); // ต้องโหลดไฟล์ ~50 MB เกิน 3 วิแน่นอน
    await prepareRelease(interaction, {
      version: interaction.options.getString("version", true),
      notes: interaction.options.getString("notes")?.replaceAll("\\n", "\n").trim(),
      force: interaction.options.getBoolean("force") ?? false,
    });
  },

  async "release-notify"(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL });
    await interaction.editReply(await prepareResend(interaction));
  },

  async announce(interaction) {
    const view = prepareAnnounce(interaction, interaction.options.getString("text", true), interaction.options.getString("level"));
    await interaction.reply({ ...view, flags: EPHEMERAL });
  },

  async "announce-clear"(interaction) {
    await interaction.reply({ ...prepareAnnounceClear(interaction), flags: EPHEMERAL });
  },

  async key(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const { row, plans } = await loadKey(interaction.options.getString("key", true));
    await interaction.editReply(keyView(row, plans));
  },
};

/** แปลง error เป็นข้อความที่แสดงให้แอดมินได้ (null = error ภายใน ไม่ควรโชว์รายละเอียด) */
export const adminErrorMessage = (err) => (err instanceof AdminError ? err.message : null);

/** รับ interaction ที่ customId ขึ้นต้นด้วย "ak:" — คืน false ถ้าไม่ใช่ของระบบคีย์ */
export async function handleLicenseInteraction(interaction) {
  const isOurs =
    (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith("ak:");
  if (!isOurs) return false;

  try {
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({
        embeds: [statusEmbed("ไม่มีสิทธิ์ใช้งาน", "ใช้ได้เฉพาะแอดมินเท่านั้น", "error")],
        flags: EPHEMERAL,
      });
    } else if (interaction.isButton()) await handleButton(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
    else await handleSelect(interaction);
  } catch (err) {
    if (!(err instanceof AdminError)) throw err; // ให้ dispatchInteraction ใน index.js จัดการ
    const payload = { embeds: [statusEmbed("เกิดข้อผิดพลาด", err.message, "error")], flags: EPHEMERAL };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
  return true;
}
