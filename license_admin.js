import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
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

const KEY_ALPHABET ="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ตัด 0/O/1/I ที่อ่านสับสน
const PLANS = { basic: 1, plus: 2, pro: 5 };
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
    if (detail.includes("max_accounts")) {
      throw new AdminError("ตาราง licenses ยังไม่มีคอลัมน์แพ็กเกจ — รัน supabase/license.sql อีกครั้งใน SQL Editor");
    }
    if (detail.includes("PGRST205")) {
      const table = query.startsWith("app_info") ? "app_info" : "license";
      throw new AdminError(`ยังไม่มีตาราง — รัน supabase/${table}.sql ใน Supabase SQL Editor ก่อน`);
    }
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

function planName(accounts) {
  const n = accounts ?? 1;
  const name = Object.keys(PLANS).find((p) => PLANS[p] === n);
  return name ? name[0].toUpperCase() + name.slice(1) : "Custom";
}
const planLabel = (accounts) => `${planName(accounts)} · ${accounts ?? 1} บัญชี`;

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

function parseAccounts(planText, accountsText) {
  const plan = (planText || "basic").trim().toLowerCase();
  if (!(plan in PLANS)) throw new AdminError("แพ็กเกจต้องเป็น basic / plus / pro");
  const accounts = accountsText?.trim() ? Number(accountsText.trim()) : PLANS[plan];
  if (!Number.isInteger(accounts) || accounts < 1 || accounts > 50) throw new AdminError("จำนวนบัญชีต้องอยู่ระหว่าง 1–50");
  return accounts;
}

async function getAppInfo() {
  const rows = await api("GET", "app_info?id=eq.1&select=*");
  if (!rows?.length) throw new AdminError("ไม่พบตาราง app_info — รัน supabase/app_info.sql ใน SQL Editor ก่อน");
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
        `-# \`v${previous}\` ➜ \`v${version}\` · <t:${now}:D>`,
        "",
        force
          ? "> 🔴 **บังคับอัปเดต**\n> เวอร์ชันเก่าจะกดเริ่มทำงานไม่ได้จนกว่าจะอัปเดต"
          : "> 🟢 **มีเวอร์ชันใหม่พร้อมให้อัปเดตแล้ว**\n> อัปเดตเพื่อใช้ฟีเจอร์ล่าสุดและการแก้ไขข้อผิดพลาด",
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
        "`1` ดาวน์โหลดไฟล์ zip จากปุ่มด้านล่าง",
        "`2` แตกไฟล์ zip",
        "`3` เปิดโปรแกรมเวอร์ชันใหม่ได้เลย",
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

/** ส่งแจ้งเตือนเวอร์ชันใหม่ไปทุกห้อง — คืนรายงานผลทีละห้อง */
async function announceRelease(release, test) {
  const rooms = [
    ...UPDATE_WEBHOOKS.map((url, i) => ({ kind: "update", label: `แจ้งอัปเดต #${i + 1}`, url })),
    ...DOWNLOAD_WEBHOOKS.map((url, i) => ({ kind: "download", label: `ห้องโหลด #${i + 1}`, url })),
  ];
  if (!rooms.length) return ["⚠️ ยังไม่ได้ตั้ง RELEASE_WEBHOOKS_UPDATE / RELEASE_WEBHOOKS_DOWNLOAD ใน .env — ไม่ได้ส่งแจ้งเตือน"];

  // ห้องแจ้งอัปเดตจะแท็กห้องโหลดที่อยู่เซิร์ฟเวอร์เดียวกันเท่านั้น (แท็กข้ามเซิร์ฟ คนที่ไม่ได้อยู่จะเห็นเป็น #unknown)
  // เซิร์ฟไหนไม่มีห้องโหลด = ใส่ลิงก์ดาวน์โหลดตรงแทน
  const infos = await Promise.all(rooms.map((room) => webhookInfo(room.url)));
  rooms.forEach((room, i) => Object.assign(room, { guildId: infos[i].guild_id, channelId: infos[i].channel_id }));
  const downloadChannelIn = (guildId) =>
    guildId ? rooms.find((r) => r.kind === "download" && r.guildId === guildId)?.channelId ?? null : null;

  return Promise.all(
    rooms.map(async (room) => {
      try {
        const { update, download, buttons } = releaseEmbeds(release, downloadChannelIn(room.guildId), test);
        const payload =
          room.kind === "update" ? { embeds: [update] } : { embeds: [download], components: buttons };
        const target = test && TEST_WEBHOOK ? TEST_WEBHOOK : room.url;
        await sendWebhook(target, payload);
        return `✅ ${room.label}${target === room.url ? "" : " (ส่งไปห้องทดสอบ)"}`;
      } catch (err) {
        return `❌ ${room.label} — ${err.message}`;
      }
    }),
  );
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

function keyView(row, notice) {
  const st = statusOf(row);
  const embed = new EmbedBuilder()
    .setTitle("🔑 รายละเอียดคีย์")
    .setDescription(`${notice ? `${notice}\n` : ""}\`\`\`${row.key}\`\`\``)
    .setColor(st.color)
    .addFields(
      { name: "สถานะ", value: st.text, inline: true },
      { name: "ระยะเวลา", value: fmtHours(row.duration_hours), inline: true },
      { name: "แพ็กเกจ", value: planLabel(row.max_accounts), inline: true },
      { name: "เริ่มใช้", value: fmtTs(row.activated_at), inline: true },
      { name: "หมดอายุ", value: fmtTs(row.expires_at), inline: true },
      { name: "ใช้ล่าสุด", value: fmtTs(row.last_seen_at), inline: true },
      { name: "ผูกเครื่อง", value: row.hwid ? `\`${row.hwid.slice(0, 16).toUpperCase()}\`` : "-", inline: true },
      { name: "หมายเหตุ", value: row.note || "-", inline: true },
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
  const current = row.max_accounts ?? 1;
  const planSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ak:plan:${k}`)
      .setPlaceholder(`เปลี่ยนแพ็กเกจ (ตอนนี้: ${planLabel(current)})`)
      .addOptions(
        ...Object.entries(PLANS).map(([name, n]) => ({
          label: `${planName(n)} · ${n} บัญชี`,
          value: name,
          default: n === current,
        })),
        { label: "กำหนดจำนวนบัญชีเอง…", value: "custom", emoji: "✏️" },
      ),
  );
  return { embeds: [embed], components: [actions, planSelect] };
}

function listView(rows, page, showAll) {
  const filtered = showAll ? rows : rows.filter((r) => statusOf(r).live);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const lines = slice.map((r) => {
    const note = r.note ? ` · ${truncate(r.note, 40)}` : "";
    return `\`${r.key}\` · ${fmtHours(r.duration_hours)} · ${planName(r.max_accounts)}\n└ ${statusOf(r).text}${note}`;
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

function appView(info, notice) {
  const level = LEVELS[info.announcement_level] ?? info.announcement_level;
  const embed = new EmbedBuilder()
    .setTitle(`📢 อัปเดต / ประกาศ${RELEASE_TEST_MODE ? "  ·  🧪 โหมดทดสอบปล่อยเวอร์ชัน" : ""}`)
    .setDescription(truncate(notice || "", 4000) || null)
    .setColor(RELEASE_TEST_MODE ? COLORS.warning : COLORS.info)
    .addFields(
      { name: "เวอร์ชันล่าสุด", value: String(info.latest_version), inline: true },
      { name: "ขั้นต่ำที่ใช้ได้", value: `${info.min_version} (ต่ำกว่านี้ = บังคับอัปเดต)`, inline: true },
      { name: "ลิงก์ดาวน์โหลด", value: info.download_url || "-" },
      { name: "สิ่งที่เปลี่ยน", value: truncate(info.changelog || "-", 1024) },
      { name: "ประกาศ", value: info.announcement ? truncate(`${info.announcement}  [${level}]`, 1024) : "-" },
    );
  const row = new ActionRowBuilder().addComponents(
    button("ak:rel", RELEASE_TEST_MODE ? "ทดสอบปล่อยเวอร์ชัน" : "ปล่อยเวอร์ชันใหม่", ButtonStyle.Success, RELEASE_TEST_MODE ? "🧪" : "🚀"),
    button("ak:ann", "ประกาศ", ButtonStyle.Primary, "📣"),
    button("ak:annclr", "ลบประกาศ", ButtonStyle.Danger, "🗑️").setDisabled(!info.announcement),
    button("ak:app", "รีเฟรช", ButtonStyle.Secondary, "🔄"),
  );
  return { embeds: [embed], components: [row] };
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
async function handleGenSubmit(interaction) {
  const hours = parseDuration(field(interaction, "duration"));
  const accounts = parseAccounts(field(interaction, "plan"), field(interaction, "accounts"));
  const count = Number(field(interaction, "count") || "1");
  if (!Number.isInteger(count) || count < 1 || count > MAX_GEN) throw new AdminError(`จำนวนคีย์ต้องอยู่ระหว่าง 1–${MAX_GEN}`);
  const note = field(interaction, "note") || null;

  await interaction.deferReply({ flags: EPHEMERAL });
  const rows = Array.from({ length: count }, () => ({ key: newKey(), duration_hours: hours, note, max_accounts: accounts }));
  const created = await api("POST", "licenses", rows, "return=representation");
  const notice = `✅ สร้างคีย์ ${fmtHours(hours)} แพ็กเกจ ${planLabel(accounts)} แล้ว (เริ่มนับเวลาเมื่อลูกค้าใช้คีย์ครั้งแรก)`;

  if (created.length === 1) return interaction.editReply(keyView(created[0], notice));
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

  await interaction.deferUpdate();
  let row = await getRow(key);
  let notice;
  if (action === "hwid") {
    row = await updateRow(row.key, { hwid: null });
    notice = "✅ ปลดเครื่องแล้ว — ลูกค้าใส่คีย์เดิมในเครื่องใหม่ได้เลย (เวลาที่เหลือเดินต่อ)";
  } else if (action === "revoke") {
    row = await updateRow(row.key, { status: "revoked" });
    notice = "⛔ ยกเลิกคีย์แล้ว — โปรแกรมลูกค้าจะหยุดภายใน 10 นาที";
  } else if (action === "restore") {
    row = await updateRow(row.key, { status: "active" });
    notice = "♻️ เปิดใช้คีย์อีกครั้งแล้ว";
  }
  await interaction.editReply(keyView(row, notice));
}

async function handleKeyModal(interaction, action, key) {
  await interaction.deferUpdate();
  let row = await getRow(key);
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
    notice = `✅ ต่ออายุ ${fmtHours(hours)} แล้ว`;
  } else if (action === "notem") {
    row = await updateRow(row.key, { note: field(interaction, "note") || null });
    notice = "✅ แก้หมายเหตุแล้ว";
  } else if (action === "accm") {
    const accounts = parseAccounts("basic", field(interaction, "accounts"));
    row = await updateRow(row.key, { max_accounts: accounts });
    notice = `✅ เปลี่ยนเป็นแพ็กเกจ ${planLabel(accounts)} แล้ว — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที`;
  }
  await interaction.editReply(keyView(row, notice));
}

async function handlePlanSelect(interaction, key) {
  const plan = interaction.values[0];
  if (plan === "custom") {
    return interaction.showModal(
      modal(`ak:accm:${key}`, "กำหนดจำนวนบัญชีเอง", [{ id: "accounts", label: "จำนวนบัญชีที่รันพร้อมกัน (1–50)", placeholder: "10", max: 2 }]),
    );
  }
  await interaction.deferUpdate();
  const row = await updateRow((await getRow(key)).key, { max_accounts: PLANS[plan] });
  await interaction.editReply(
    keyView(row, `✅ เปลี่ยนเป็นแพ็กเกจ ${planLabel(PLANS[plan])} แล้ว — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที`),
  );
}

async function handleAppModal(interaction, id) {
  await interaction.deferUpdate();
  let info;
  let notice;
  if (id === "ak:relm") {
    const version = field(interaction, "version");
    const url = field(interaction, "url");
    const force = /^(y|yes|ใช่|1|true)$/i.test(field(interaction, "force"));
    const current = await getAppInfo();
    if (compareVersion(version, current.latest_version) < 0) {
      throw new AdminError(`${version} เก่ากว่าเวอร์ชันล่าสุดที่ประกาศไว้ (${current.latest_version})`);
    }
    if (!/^https?:\/\//.test(url)) throw new AdminError("ลิงก์ต้องขึ้นต้นด้วย https://");
    const notes = field(interaction, "notes") || null;
    const release = { version, previous: current.latest_version, url, notes, force };

    if (RELEASE_TEST_MODE) {
      info = current; // โหมดทดสอบ: ไม่บันทึกลง DB
      notice = `🧪 **โหมดทดสอบ** — ส่งแจ้งเตือน v${version} แล้ว แต่ยังไม่ได้บันทึกลง DB (โปรแกรมลูกค้าไม่เปลี่ยน)`;
    } else {
      const fields = { latest_version: version, download_url: url, changelog: notes };
      if (force) fields.min_version = version;
      info = await updateAppInfo(fields);
      notice = `🚀 ประกาศเวอร์ชัน ${version} แล้ว — โปรแกรมลูกค้าจะเห็นภายใน 30 นาที` +
        (force ? "\nเวอร์ชันเก่าจะกดเริ่มทำงานไม่ได้จนกว่าจะอัปเดต" : "");
    }
    notice += `\n\n**แจ้งเตือนห้อง Discord**\n${(await announceRelease(release, RELEASE_TEST_MODE)).join("\n")}`;
  } else {
    const level = (field(interaction, "level") || "info").toLowerCase();
    if (!(level in LEVELS)) throw new AdminError("ระดับต้องเป็น info / warn / critical");
    info = await updateAppInfo({
      announcement: field(interaction, "text"),
      announcement_level: level,
      announcement_at: new Date().toISOString(),
    });
    notice = "📣 ประกาศแล้ว — โปรแกรมลูกค้าจะเห็นภายใน 30 นาที";
  }
  await interaction.editReply(appView(info, notice));
}

async function handleButton(interaction) {
  const id = interaction.customId;
  const [, action, ...rest] = id.split(":");

  switch (action) {
    case "gen":
      return interaction.showModal(
        modal("ak:genm", "สร้างคีย์ใหม่", [
          { id: "duration", label: "ระยะเวลา (12h / 1d / 7d / 30d / 2w)", placeholder: "30d", max: 10 },
          { id: "plan", label: "แพ็กเกจ (basic=1 / plus=2 / pro=5 บัญชี)", value: "basic", max: 10 },
          { id: "accounts", label: "จำนวนบัญชีเอง (เว้นว่าง = ตามแพ็กเกจ)", required: false, max: 2 },
          { id: "count", label: `จำนวนคีย์ (1–${MAX_GEN})`, value: "1", max: 2 },
          { id: "note", label: "หมายเหตุ เช่น ชื่อลูกค้า", required: false, max: 200 },
        ]),
      );
    case "find":
      return interaction.showModal(
        modal("ak:findm", "จัดการคีย์", [{ id: "key", label: "License Key", placeholder: "APF-XXXX-XXXX-XXXX-XXXX", max: 40 }]),
      );
    case "listopen": {
      await interaction.deferReply({ flags: EPHEMERAL });
      const rows = await api("GET", "licenses?select=*&order=created_at.desc");
      return interaction.editReply(listView(rows, 0, false));
    }
    case "list": {
      await interaction.deferUpdate();
      const rows = await api("GET", "licenses?select=*&order=created_at.desc");
      return interaction.editReply(listView(rows, Number(rest[0]), rest[1] === "1"));
    }
    case "appopen":
      await interaction.deferReply({ flags: EPHEMERAL });
      return interaction.editReply(appView(await getAppInfo()));
    case "app":
      await interaction.deferUpdate();
      return interaction.editReply(appView(await getAppInfo()));
    case "annclr":
      await interaction.deferUpdate();
      return interaction.editReply(appView(await updateAppInfo({ announcement: null, announcement_at: null }), "🗑️ ลบประกาศแล้ว"));
    case "rel":
      return interaction.showModal(
        modal("ak:relm", RELEASE_TEST_MODE ? "ทดสอบปล่อยเวอร์ชัน (ไม่บันทึก DB)" : "ปล่อยเวอร์ชันใหม่", [
          { id: "version", label: "เลขเวอร์ชัน (ตรงกับ version.py ตัวที่ build)", placeholder: "1.0.1", max: 20 },
          { id: "url", label: "ลิงก์ดาวน์โหลดไฟล์ zip", placeholder: "https://...", max: 500 },
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
    case "view":
      await interaction.deferUpdate();
      return interaction.editReply(keyView(await getRow(rest[0])));
    default:
      return handleKeyAction(interaction, action, rest[0]);
  }
}

async function handleModal(interaction) {
  const id = interaction.customId;
  if (id === "ak:genm") return handleGenSubmit(interaction);
  if (id === "ak:findm") {
    await interaction.deferReply({ flags: EPHEMERAL });
    return interaction.editReply(keyView(await getRow(field(interaction, "key"))));
  }
  if (id === "ak:relm" || id === "ak:annm") return handleAppModal(interaction, id);
  const [, action, key] = id.split(":");
  return handleKeyModal(interaction, action, key);
}

async function handleSelect(interaction) {
  if (interaction.customId === "ak:pick") {
    await interaction.deferReply({ flags: EPHEMERAL });
    return interaction.editReply(keyView(await getRow(interaction.values[0])));
  }
  return handlePlanSelect(interaction, interaction.customId.split(":")[2]);
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

  async key(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL });
    await interaction.editReply(keyView(await getRow(interaction.options.getString("key", true))));
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
