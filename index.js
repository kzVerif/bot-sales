import "dotenv/config";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Impit } from "impit";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { adminErrorMessage, handleLicenseInteraction, isAdmin, licenseCommands, licenseHelp } from "./license_admin.js";

// ==========================================
// 1. Configuration
// ==========================================
// ⚠️ token อยู่ในไฟล์ .env (BOT_TOKEN=...) ไม่ใส่ในโค้ดแล้ว
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_PHONE_NUMBER = "0827695499";
const ADMIN_ROLE_ID = "1498314230494134445"; // (ไม่ได้ใช้งาน — เก็บไว้เหมือนไฟล์เดิม)
// ID ของ Discord ต้องเป็น string เสมอ (ตัวเลขยาวเกินที่ JS เก็บได้แม่นยำ)
const OWNER_ID = "472356060632580097"; // เจ้าของบอท — รับ DM แจ้งเตือนเมื่อมีคนซื้อ
const PREFIX = "!ap"; // คำสั่งแอดมินทั้งหมด เช่น !ap postshop, !ap keypanel

const STOCK_DIR = "stock";
const PRODUCTS_FILE = "products.json";
const STATS_FILE = "stats.json";

// ---- UI / branding config (edit freely, this is display only) ----
const SHOP_TITLE = "ซื้อสินค้าออโต้ | ONLINE 24/7";
const SHOP_DESCRIPTION = "เลือกสินค้าที่ต้องการและชำระเงินได้เลย \n รองรับการชำระผ่านทรูมันนี้วอลเลทเท่านั้น";
const SHOP_COLOR = 0x000000; // soft pink-purple, matches the pastel banner look
// Put your own banner artwork here (same folder as the bot script).
// If the file doesn't exist the embed simply skips the image — nothing breaks.
const BANNER_PATH = "assets/banner.png";
const BANNER_FILENAME = "banner.png";
const LOGO_PATH = "assets/logo.png";
const LOGO_FILENAME = "logo.png";
const BANNER2_PATH = "assets/banner2.png";
const BANNER2_FILENAME = "banner2.png";
const LOGO2_PATH = "assets/logo2.png";
const LOGO2_FILENAME = "logo2.png";

// Headers ที่แนบตอนยิง API เบิกซอง TrueMoney
const TRUEMONEY_HEADERS = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.6",
  "content-type": "application/json",
  priority: "u=1, i",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-gpc": "1",
};

// ==========================================
// 2. File & Stock Manager
// ==========================================
/** คิวล็อกแบบง่าย: งานที่เรียก run() จะถูกทำทีละอัน (เทียบเท่า asyncio.Lock) */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }
  async run(fn) {
    const prev = this._tail;
    let release;
    this._tail = new Promise((resolve) => (release = resolve));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** เขียนไฟล์แบบ atomic (เขียนไฟล์ชั่วคราวแล้วค่อยแทนที่) กันอ่านเจอไฟล์ที่เขียนไม่เสร็จ */
async function atomicWrite(filepath, data) {
  const tmp = `${filepath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, "utf-8");
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, filepath);
      return;
    } catch (err) {
      // บน Windows บางครั้ง rename ชนกับโปรแกรมสแกนไวรัส ลองใหม่ไม่กี่ครั้ง
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

const stripBom = (text) => text.replace(/^\uFEFF/, "");
const splitLines = (text) => text.split(/\r?\n/);

class StockManager {
  constructor() {
    this.lock = new Mutex();
    this.productsIO = new Mutex();
    this.statsIO = new Mutex();

    if (!existsSync(STOCK_DIR)) mkdirSync(STOCK_DIR, { recursive: true });
    if (!existsSync(PRODUCTS_FILE)) writeFileSync(PRODUCTS_FILE, JSON.stringify({}, null, 4), "utf-8");
    if (!existsSync(STATS_FILE)) writeFileSync(STATS_FILE, JSON.stringify({ total_sold: 0 }, null, 4), "utf-8");
  }

  /** path ของไฟล์สต็อก (คืน null ถ้าชื่อมีตัวอักษรที่ใช้หลุดโฟลเดอร์ได้ เช่น / \ ..) */
  _stockPath(name) {
    const file = `${String(name).toLowerCase()}.txt`;
    if (path.basename(file) !== file || file.startsWith("..")) return null;
    return path.join(STOCK_DIR, file);
  }

  async _loadProducts() {
    return this.productsIO.run(async () => JSON.parse(stripBom(await fs.readFile(PRODUCTS_FILE, "utf-8"))));
  }

  async _saveProducts(data) {
    return this.productsIO.run(() => atomicWrite(PRODUCTS_FILE, JSON.stringify(data, null, 4)));
  }

  async createProduct(name, price) {
    return this.lock.run(async () => {
      const products = await this._loadProducts();
      const nameLower = name.toLowerCase();
      const filepath = this._stockPath(name);
      if (!filepath) return { success: false, msg: "ชื่อสินค้าไม่ถูกต้อง (ห้ามมี / \\ หรือ ..)" };
      if (Object.hasOwn(products, nameLower)) return { success: false, msg: "สินค้ามีอยู่แล้ว" };

      products[nameLower] = { name, price };
      await this._saveProducts(products);

      await fs.writeFile(filepath, "", "utf-8");
      return { success: true, msg: `สร้างสินค้า '${name}' เรียบร้อย` };
    });
  }

  async addStockLines(name, lines) {
    return this.lock.run(async () => {
      const filepath = this._stockPath(name);
      if (!filepath || !existsSync(filepath)) return { success: false, msg: "ไม่พบสินค้า" };

      const validLines = lines.map((l) => l.trim()).filter((l) => l);
      if (validLines.length === 0) return { success: false, msg: "ไม่มีข้อมูลที่จะเพิ่ม" };

      await fs.appendFile(filepath, validLines.map((l) => `${l}\n`).join(""), "utf-8");
      return { success: true, msg: `เพิ่มสต็อก ${validLines.length} ชิ้น` };
    });
  }

  async getStockCount(name) {
    const filepath = this._stockPath(name);
    if (!filepath || !existsSync(filepath)) return 0;
    const text = await fs.readFile(filepath, "utf-8");
    return splitLines(text).filter((l) => l.trim()).length;
  }

  async popFirstItem(name) {
    return this.lock.run(async () => {
      const filepath = this._stockPath(name);
      if (!filepath || !existsSync(filepath)) return null;

      const text = await fs.readFile(filepath, "utf-8");
      const validLines = splitLines(text)
        .map((l) => l.trim())
        .filter((l) => l);
      if (validLines.length === 0) return null;

      const itemToDeliver = validLines.shift();
      await atomicWrite(filepath, validLines.length ? validLines.join("\n") + "\n" : "");
      return itemToDeliver;
    });
  }

  async popItems(name, quantity) {
    return this.lock.run(async () => {
      const filepath = this._stockPath(name);
      if (!filepath || !existsSync(filepath)) return null;

      const text = await fs.readFile(filepath, "utf-8");
      const validLines = splitLines(text)
        .map((l) => l.trim())
        .filter((l) => l);
      if (validLines.length < quantity) return null;

      const itemsToDeliver = validLines.splice(0, quantity);
      await atomicWrite(filepath, validLines.length ? validLines.join("\n") + "\n" : "");
      return itemsToDeliver;
    });
  }

  // ---- Sold-counter helpers (display stat only, shown in the shop footer) ----
  async _loadStats() {
    return this.statsIO.run(async () => JSON.parse(stripBom(await fs.readFile(STATS_FILE, "utf-8"))));
  }

  async _saveStats(data) {
    return this.statsIO.run(() => atomicWrite(STATS_FILE, JSON.stringify(data, null, 4)));
  }

  async getTotalSold() {
    const stats = await this._loadStats();
    return stats.total_sold ?? 0;
  }

  async incrementSold(amount = 1) {
    return this.lock.run(async () => {
      const stats = await this._loadStats();
      stats.total_sold = (stats.total_sold ?? 0) + amount;
      await this._saveStats(stats);
    });
  }
}

// ==========================================
// 3. TrueMoney API Logic (ใช้ impit ปลอม TLS fingerprint หลบ WAF/Cloudflare)
// ==========================================
let impitClient = null; // reuse client เดียว ไม่ต้อง handshake ใหม่ทุกครั้ง

export const TrueMoneyAPI = {
  /** ดึงรหัสออกจากลิงก์หรือตรวจสอบรหัสล้วน */
  extractVoucherCode(inputStr) {
    inputStr = inputStr.trim();

    // 1. ตรวจสอบว่าเป็นลิงก์ TrueMoney หรือไม่
    const urlMatch = inputStr.match(/v=([A-Za-z0-9]+)/);
    if (urlMatch) {
      // รักษาตัวพิมพ์เดิมของ hash ไว้ เพราะ API อาจตรวจแบบ case-sensitive
      const code = urlMatch[1];
      if (code.length >= 10 && code.length <= 50) return code;
    }

    // 2. ตรวจสอบว่าเป็นรหัสล้วนหรือไม่
    if (/^[A-Za-z0-9]{10,50}$/.test(inputStr)) return inputStr;

    return null;
  },

  async redeemVoucher(phone, code) {
    const url = `https://gift.truemoney.com/campaign/vouchers/${code}/redeem`;
    const payload = { mobile: phone, voucher_hash: code };
    const startedAt = Date.now();
    const maskedCode = code ? `${code.slice(0, 4)}...${code.slice(-4)}` : "<empty>";
    const maskedPhone = phone ? `${String(phone).slice(0, 3)}****${String(phone).slice(-2)}` : "<empty>";

   //console.log(`[TrueMoney] redeemVoucher started code=${maskedCode} phone=${maskedPhone}`);
   //console.log(`[TrueMoney] Request payload: ${JSON.stringify({ mobile: maskedPhone, voucher_hash: maskedCode })}`);

    try {
      // browser: "chrome" คือหัวใจสำคัญ: impit ปลอม TLS Fingerprint + ลำดับ header ให้เหมือน Chrome
      if (!impitClient) {
       //console.log("[TrueMoney] Creating Impit client (browser=chrome, timeout=15000ms)");
        impitClient = new Impit({ browser: "chrome", timeout: 15000 });
      } else {
       //console.log("[TrueMoney] Reusing existing Impit client");
      }

     //console.log(`[TrueMoney] Sending POST request code=${maskedCode}`);
      const resp = await impitClient.fetch(url, {
        method: "POST",
        headers: {
          ...TRUEMONEY_HEADERS,
          Referer: `https://gift.truemoney.com/campaign/?v=${encodeURIComponent(code)}`,
        },
        body: JSON.stringify(payload),
        timeout: 15000,
      });

      // ป้องกันการ crash หาก WAF ยังส่ง HTML กลับมา
      const contentType = resp.headers.get("content-type") ?? "";
     //console.log(`[TrueMoney] Response status=${resp.status} content-type=${contentType || "<missing>"}`);
      if (!contentType.includes("application/json")) {
        console.error(`[TrueMoney] Rejected non-JSON response after ${Date.now() - startedAt}ms`);
        return {
          success: false,
          error: "ถูกบล็อกโดยระบบความปลอดภัย (WAF) กรุณารอ 1-2 นาทีแล้วลองใหม่",
        };
      }

      const data = await resp.json();
      const status = data?.status ?? {};
     //console.log(`[TrueMoney] Response body: ${JSON.stringify(data)}`);
     //console.log(`[TrueMoney] Parsed status code=${status.code ?? "<missing>"} message=${status.message ?? "<missing>"}`);

      if (resp.status === 200 && status.code === "SUCCESS") {
        const amount = parseInt(data?.data?.voucher?.redeemed_amount_baht, 10) || 0;
       //console.log(`[TrueMoney] Redeem succeeded amount=${amount} duration=${Date.now() - startedAt}ms`);
        return { success: true, amount };
      }

      console.error(`[TrueMoney] Redeem failed duration=${Date.now() - startedAt}ms error=${status.message ?? "unknown"}`);
      return { success: false, error: status.message ?? "รหัสไม่ถูกต้องหรือถูกใช้แล้ว" };
    } catch (e) {
      impitClient = null; // สร้าง client ใหม่ในครั้งถัดไป
      console.error(`[TrueMoney] Request error duration=${Date.now() - startedAt}ms`, e);
      return { success: false, error: `เกิดข้อผิดพลาด: ${e.message}` };
    }
  },
};

// ==========================================
// 3b. Shared embed helpers (UI/UX layer only)
// ==========================================
/** Main shop panel embed — title + short instruction, big banner image, footer sold counter. */
function makeShopEmbed(totalSold, variant = "default") {
  const isSecond = variant === "second";
  const bannerPath = isSecond ? BANNER2_PATH : BANNER_PATH;
  const bannerFilename = isSecond ? BANNER2_FILENAME : BANNER_FILENAME;
  const logoPath = isSecond ? LOGO2_PATH : LOGO_PATH;
  const logoFilename = isSecond ? LOGO2_FILENAME : LOGO_FILENAME;
  const embed = new EmbedBuilder().setTitle(SHOP_TITLE).setDescription(SHOP_DESCRIPTION).setColor(SHOP_COLOR);
  if (existsSync(bannerPath)) embed.setImage(`attachment://${bannerFilename}`);
  if (existsSync(logoPath)) embed.setThumbnail(`attachment://${logoFilename}`);
  embed.setFooter({ text: `ขายของไปแล้ว : ${totalSold} ชิ้น` });
  return embed;
}

/** Returns a fresh attachment for the banner, or null if not set up yet. */
function getBannerFile(variant = "default") {
  const isSecond = variant === "second";
  const bannerPath = isSecond ? BANNER2_PATH : BANNER_PATH;
  const bannerFilename = isSecond ? BANNER2_FILENAME : BANNER_FILENAME;
  if (existsSync(bannerPath)) return new AttachmentBuilder(bannerPath, { name: bannerFilename });
  return null;
}

/** Returns a fresh attachment for the shop logo, or null if not set up yet. */
function getLogoFile(variant = "default") {
  const isSecond = variant === "second";
  const logoPath = isSecond ? LOGO2_PATH : LOGO_PATH;
  const logoFilename = isSecond ? LOGO2_FILENAME : LOGO_FILENAME;
  if (existsSync(logoPath)) return new AttachmentBuilder(logoPath, { name: logoFilename });
  return null;
}

/** Small reusable embed for ephemeral feedback (success/error/warning/info). */
function makeStatusEmbed(title, description, kind = "info") {
  const colorMap = { success: 0x57f287, error: 0xed4245, warning: 0xfee75c, info: SHOP_COLOR };
  const iconMap = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
  return new EmbedBuilder()
    .setTitle(`${iconMap[kind] ?? "ℹ️"} ${title}`)
    .setDescription(description)
    .setColor(colorMap[kind] ?? SHOP_COLOR);
}

const EPHEMERAL = MessageFlags.Ephemeral;

/** รัน promise เบื้องหลังโดยไม่ต้องรอ (จับ error ไว้ไม่ให้บอทล่ม) */
function runBg(promise) {
  promise.catch((err) => console.error("Background task failed:", err));
}

/** ส่ง DM แจ้งเจ้าของบอทเมื่อมีคนซื้อสินค้า (ถ้าส่งไม่ได้จะแค่ log error ไม่ให้กระทบระบบซื้อ) */
async function notifyOwnerPurchase(client, buyer, productName, amount, item, voucherCode) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const voucherLink = `https://gift.truemoney.com/campaign/?v=${encodeURIComponent(voucherCode)}`;
    const embed = new EmbedBuilder()
      .setTitle("🛎️ มีคนซื้อสินค้า!")
      .setColor(0x57f287)
      .setTimestamp()
      .addFields(
        { name: "👤 ผู้ซื้อ", value: `${buyer}\n\`${buyer.tag}\` (ID: \`${buyer.id}\`)`, inline: false },
        { name: "🛒 สินค้า", value: productName, inline: true },
        { name: "💰 ยอดเงิน", value: `${amount} THB`, inline: true },
        { name: "📦 ข้อมูลที่ส่งให้ลูกค้า", value: `\`\`\`\n${item}\n\`\`\``, inline: false },
        { name: "🔗 ลิงก์ซอง", value: voucherLink, inline: false },
      )
      .setThumbnail(buyer.displayAvatarURL());
    await owner.send({ embeds: [embed] });
  } catch (e) {
   //console.log(`Failed to notify owner: ${e}`);
  }
}

async function sendPurchasedItemDM(user, productName, amount, item) {
  try {
    const embed = new EmbedBuilder()
      .setTitle("✅ สินค้าของคุณพร้อมใช้งาน")
      .setDescription("ขอบคุณสำหรับการสั่งซื้อ กรุณาเก็บข้อมูลสินค้านี้ไว้เป็นความลับ")
      .setColor(0x57f287)
      .addFields(
        { name: "🛒 สินค้า", value: productName, inline: true },
        { name: "💰 ยอดเงิน", value: `${amount} THB`, inline: true },
        { name: "📦 ข้อมูลสินค้า", value: `\`\`\`\n${item}\n\`\`\``, inline: false },
      );

    await user.send({ embeds: [embed] });
   //console.log(`[Purchase] Sent product DM to user=${user.id}`);
    return true;
  } catch (err) {
    console.error(`[Purchase] Failed to send product DM to user=${user.id}:`, err);
    return false;
  }
}

async function sendInsufficientPaymentDM(user, productName, quantity, paidAmount, requiredAmount) {
  try {
    const embed = new EmbedBuilder()
      .setTitle("⚠️ ยอดเงินไม่เพียงพอ")
      .setDescription(`คำสั่งซื้อ **${productName}** จำนวน ${quantity} ชิ้นถูกปฏิเสธ เนื่องจากยอดเงินในซองไม่เพียงพอ`)
      .setColor(0xfee75c)
      .addFields(
        { name: "ยอดที่ชำระมา", value: `${paidAmount} THB`, inline: true },
        { name: "ยอดที่ต้องชำระ", value: `${requiredAmount.toFixed(2)} THB`, inline: true },
        { name: "ติดต่อ", value: `กรุณาติดต่อ Owner: <@${OWNER_ID}> เพื่อขอความช่วยเหลือ`, inline: false },
      );

    await user.send({ embeds: [embed] });
   //console.log(`[Purchase] Sent insufficient-payment DM to user=${user.id}`);
    return true;
  } catch (err) {
    console.error(`[Purchase] Failed to send insufficient-payment DM to user=${user.id}:`, err);
    return false;
  }
}

async function notifyOwnerInsufficientPayment(client, buyer, productName, quantity, paidAmount, requiredAmount, voucherCode) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const voucherLink = `https://gift.truemoney.com/campaign/?v=${encodeURIComponent(voucherCode)}`;
    const embed = new EmbedBuilder()
      .setTitle("⚠️ คำสั่งซื้อถูกปฏิเสธ: ยอดเงินไม่พอ")
      .setColor(0xfee75c)
      .addFields(
        { name: "ผู้ซื้อ", value: `${buyer}\nID: \`${buyer.id}\``, inline: false },
        { name: "สินค้า", value: productName, inline: true },
        { name: "จำนวน", value: String(quantity), inline: true },
        { name: "ยอดที่ชำระมา", value: `${paidAmount} THB`, inline: true },
        { name: "ยอดที่ต้องชำระ", value: `${requiredAmount.toFixed(2)} THB`, inline: true },
        { name: "🔗 ลิงก์ซอง", value: voucherLink, inline: false },
        { name: "การดำเนินการ", value: "ซองถูก redeem แล้ว แต่ยังไม่ได้ตัดสต็อก กรุณาติดต่อผู้ซื้อเพื่อดำเนินการต่อ", inline: false },
      )
      .setTimestamp();

    await owner.send({ embeds: [embed] });
   //console.log(`[Purchase] Notified owner about insufficient payment user=${buyer.id}`);
    return true;
  } catch (err) {
    console.error("[Purchase] Failed to notify owner about insufficient payment:", err);
    return false;
  }
}

// ==========================================
// 4. Discord UI Components
// ==========================================
const SELECT_ID = "shop_select";
const SELECT_ID_2 = "shop_select_2";
const CLEAR_SELECTION_ID = "shop_clear_selection";
const RELOAD_ID = "reload_shop";
const MODAL_PREFIX = "purchase:";

/** สร้างแผง dropdown เลือกสินค้า + ปุ่มรีเฟรช (เทียบเท่า build_shop_view) */
async function buildShopComponents(products, stockManager, variant = "default") {
  // กันไว้ 1 ช่องสำหรับตัวเลือก "ล้างตัวเลือก" (Discord จำกัดไม่เกิน 25 ตัวเลือก)
  const entries = Object.entries(products).slice(0, 24);
  const counts = await Promise.all(entries.map(([key]) => stockManager.getStockCount(key)));

  const options = entries.map(([key, data], i) => {
    const price = Number(data.price).toFixed(2);
    const desc = `ราคา: ${price} บาท | คงเหลือ: ${counts[i]} ชิ้น`;
    return new StringSelectMenuOptionBuilder().setLabel(String(data.name).slice(0, 100)).setDescription(desc).setValue(key);
  });
  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel("ล้างตัวเลือก")
      .setDescription("ยกเลิกการเลือกสินค้า")
      .setValue(CLEAR_SELECTION_ID),
  );

  const rows = [];
  if (options.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(variant === "second" ? SELECT_ID_2 : SELECT_ID).setPlaceholder("เลือกสินค้าที่นี่").setMinValues(1).setMaxValues(1).addOptions(options),
      ),
    );
  }
  // rows.push(
  //   new ActionRowBuilder().addComponents(
  //     new ButtonBuilder().setCustomId(RELOAD_ID).setLabel("รีเฟรชสต็อก").setStyle(ButtonStyle.Secondary).setEmoji("🔄"),
  //   ),
  // );
  return rows;
}

/** อัปเดตแผงร้านค้าเดิมหลังมีคนซื้อ (ทำเบื้องหลัง) */
async function refreshShopEmbed(interaction) {
  try {
    const message = interaction.isFromMessage?.() ? interaction.message : null;
    if (!message) return;
    const variant = message.components?.some((row) => row.components?.some((component) => component.customId === SELECT_ID_2))
      ? "second"
      : "default";
    const products = await stockManager._loadProducts();
    const components = await buildShopComponents(products, stockManager, variant);
    const totalSold = await stockManager.getTotalSold();
    // แนบรูปแบนเนอร์เดิมไว้ให้อัตโนมัติ ตราบใดที่เราไม่ส่ง attachments ใหม่
    await message.edit({ embeds: [makeShopEmbed(totalSold, variant)], components });
  } catch (e) {
   //console.log(`Failed to refresh shop embed: ${e}`);
  }
}

/** เลือกสินค้าจาก dropdown → เปิดหน้าต่างกรอกลิงก์ซอง (ต้องเปิด modal เป็น response แรก จึง defer ไม่ได้) */
async function handleProductSelect(interaction) {
  const selectedValue = interaction.values[0];
  const variant = interaction.customId === SELECT_ID_2 ? "second" : "default";

  if (selectedValue === CLEAR_SELECTION_ID) {
    const products = await stockManager._loadProducts();
    const components = await buildShopComponents(products, stockManager, variant);
    const totalSold = await stockManager.getTotalSold();
    await interaction.update({ embeds: [makeShopEmbed(totalSold, variant)], components });
    return;
  }

  const products = await stockManager._loadProducts();
  const productData = Object.hasOwn(products, selectedValue) ? products[selectedValue] : null;

  if (!productData) {
    return interaction.reply({
      embeds: [makeStatusEmbed("ไม่พบสินค้า", "สินค้าที่เลือกอาจถูกลบไปแล้ว ลองกด 🔄 รีโหลดแผงร้านค้า", "error")],
      flags: EPHEMERAL,
    });
  }

  const count = await stockManager.getStockCount(selectedValue);
  if (count === 0) {
    return interaction.reply({
      embeds: [makeStatusEmbed("สินค้าหมดสต็อก", `**${productData.name}** หมดชั่วคราว กรุณาลองใหม่ภายหลัง`, "warning")],
      flags: EPHEMERAL,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${selectedValue}`)
    .setTitle(`💳 ชำระเงิน • ${productData.name} (${productData.price}฿)`.slice(0, 45)) // Discord จำกัดชื่อ modal 45 ตัวอักษร
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
        .setCustomId("voucher")
          .setLabel("ลิงก์ หรือ รหัส Angpao TrueMoney")
          .setPlaceholder("วางลิงก์เต็ม หรือ รหัส เช่น 019aa077...")
          .setMinLength(10)
          .setMaxLength(150) // เพิ่มความยาวให้รองรับ URL
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quantity")
          .setLabel("จำนวนสินค้าที่ต้องการซื้อ")
          .setPlaceholder("เช่น 1")
          .setMinLength(1)
          .setMaxLength(2)
          .setValue("1")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

/** ส่งลิงก์ซองในหน้าต่าง modal → เบิกเงิน → ส่งสินค้า */
async function handlePurchaseSubmit(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });

  const productKey = interaction.customId.slice(MODAL_PREFIX.length);
  const products = await stockManager._loadProducts();
  const productData = Object.hasOwn(products, productKey) ? products[productKey] : null;
  const productName = productData?.name ?? productKey;
  const quantity = Number.parseInt(interaction.fields.getTextInputValue("quantity"), 10);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return interaction.followUp({
      embeds: [makeStatusEmbed("จำนวนไม่ถูกต้อง", "กรุณาระบุจำนวนเป็นเลขจำนวนเต็มตั้งแต่ 1 ถึง 99", "error")],
      flags: EPHEMERAL,
    });
  }

  const unitPrice = Number(productData?.price);
  if (!productData || !Number.isFinite(unitPrice) || unitPrice < 0) {
    return interaction.followUp({
      embeds: [makeStatusEmbed("ไม่พบข้อมูลสินค้า", "กรุณาลองเลือกสินค้าใหม่อีกครั้ง", "error")],
      flags: EPHEMERAL,
    });
  }

  const requiredAmount = unitPrice * quantity;

  const availableStock = await stockManager.getStockCount(productKey);
  if (availableStock < quantity) {
    return interaction.followUp({
      embeds: [makeStatusEmbed("สต็อกไม่พอ", `สินค้านี้เหลือ ${availableStock} ชิ้น แต่คุณขอซื้อ ${quantity} ชิ้น`, "warning")],
      flags: EPHEMERAL,
    });
  }

  // ดึงรหัสที่สะอาดออกมา (ไม่ว่าผู้ใช้จะวางลิงก์หรือรหัสล้วน)
  const cleanCode = TrueMoneyAPI.extractVoucherCode(interaction.fields.getTextInputValue("voucher"));

  if (!cleanCode) {
    return interaction.followUp({
      embeds: [makeStatusEmbed("รูปแบบไม่ถูกต้อง", "กรุณาวางลิงก์ TrueMoney ที่ถูกต้อง หรือใส่รหัสล้วน แล้วลองอีกครั้ง", "error")],
      flags: EPHEMERAL,
    });
  }

  const result = await TrueMoneyAPI.redeemVoucher(SHOP_PHONE_NUMBER, cleanCode);

  if (!result.success) {
    return interaction.followUp({
      embeds: [makeStatusEmbed("เบิกเงินไม่สำเร็จ", result.error, "error")],
      flags: EPHEMERAL,
    });
  }

  const paidAmount = Number(result.amount);
  if (!Number.isFinite(paidAmount) || paidAmount < requiredAmount) {
    const ownerNotified = await notifyOwnerInsufficientPayment(
      interaction.client,
      interaction.user,
      productName,
      quantity,
      result.amount,
      requiredAmount,
      cleanCode,
    );
    const buyerNotified = await sendInsufficientPaymentDM(
      interaction.user,
      productName,
      quantity,
      result.amount,
      requiredAmount,
    );

    return interaction.followUp({
      embeds: [
        makeStatusEmbed(
          "ยอดเงินไม่เพียงพอ",
          `คำสั่งซื้อถูกปฏิเสธ ยอดที่ต้องชำระ ${requiredAmount.toFixed(2)} THB แต่ได้รับ ${result.amount} THB\nกรุณาติดต่อ Owner: <@${OWNER_ID}>${ownerNotified ? "" : " (ระบบแจ้ง Owner ไม่สำเร็จ)"}${buyerNotified ? "\nรายละเอียดถูกส่งไปทาง DM แล้ว" : "\nไม่สามารถส่ง DM ได้ กรุณาติดต่อ Owner โดยตรง"}`,
          "warning",
        ),
      ],
      flags: EPHEMERAL,
    });
  }

  const items = await stockManager.popItems(productKey, quantity);

  if (!items) {
    return interaction.followUp({
      embeds: [
        makeStatusEmbed(
          "สินค้าหมดสต็อก",
          "เบิกเงินสำเร็จแล้ว แต่สินค้าชิ้นนี้หมดสต็อกพอดี กรุณาติดต่อ Admin เพื่อขอความช่วยเหลือ",
          "warning",
        ),
      ],
      flags: EPHEMERAL,
    });
  }

  await stockManager.incrementSold(quantity);
  const deliveredItems = items.map((item, index) => `#${index + 1}\n${item}`).join("\n");
  const dmSent = await sendPurchasedItemDM(interaction.user, productName, result.amount, deliveredItems);

  const embed = new EmbedBuilder()
    .setTitle("✅ ชำระเงินสำเร็จ!")
    .setDescription("ขอบคุณที่ใช้บริการร้านค้าของเรา 🎉")
    .setColor(0x57f287)
    .addFields(
      { name: "🛒 สินค้า", value: productName, inline: true },
      { name: "🔢 จำนวน", value: String(quantity), inline: true },
      { name: "💰 ยอดเงิน", value: `${result.amount} THB`, inline: true },
      { name: "📨 การส่งสินค้า", value: dmSent ? "ส่งสินค้าไปทาง DM แล้ว" : "ส่ง DM ไม่สำเร็จ กรุณาติดต่อ Admin", inline: false },
      { name: "📦 ข้อมูลของคุณ", value: `\`\`\`\n${deliveredItems}\n\`\`\``, inline: false },
    )
    .setFooter({ text: "กรุณาเก็บข้อมูลนี้ไว้เป็นความลับ" });
  await interaction.followUp({ embeds: [embed], flags: EPHEMERAL });

  runBg(notifyOwnerPurchase(interaction.client, interaction.user, productName, result.amount, deliveredItems, cleanCode));
  runBg(refreshShopEmbed(interaction));
}

/** ปุ่มรีเฟรชสต็อก */
async function handleReload(interaction) {
  await interaction.deferUpdate();

  const variant = interaction.message.components?.some((row) => row.components?.some((component) => component.customId === SELECT_ID_2))
    ? "second"
    : "default";
  const products = await stockManager._loadProducts();
  const components = await buildShopComponents(products, stockManager, variant);
  const totalSold = await stockManager.getTotalSold();

  await interaction.message.edit({ embeds: [makeShopEmbed(totalSold, variant)], components });
  await interaction.followUp({
    embeds: [makeStatusEmbed("รีเฟรชสำเร็จ", "อัปเดตแผงร้านค้าและจำนวนสต็อกล่าสุดแล้ว", "success")],
    flags: EPHEMERAL,
  });
}

// ==========================================
// 5. Bot Setup & Commands
// ==========================================
export const stockManager = new StockManager();
export const client = new Client({
  // GuildMessages + MessageContent ใช้อ่านคำสั่ง !ap (ต้องเปิด Message Content Intent ใน Developer Portal ด้วย)
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const replyStatus = (message, title, description, kind) =>
  message.reply({ embeds: [makeStatusEmbed(title, description, kind)] });

/** โพสต์แผงร้านค้าในช่องที่พิมพ์คำสั่ง แล้วลบข้อความคำสั่งทิ้ง */
async function postShopPanel(message, variant) {
  const products = await stockManager._loadProducts();
  if (Object.keys(products).length === 0) {
    return replyStatus(message, "ยังไม่มีสินค้า", "กรุณาใช้ `!ap createproduct` เพื่อเพิ่มสินค้าก่อนโพสต์ร้านค้า", "warning");
  }
  const totalSold = await stockManager.getTotalSold();
  const embed = makeShopEmbed(totalSold, variant);
  const components = await buildShopComponents(products, stockManager, variant);
  const files = [getBannerFile(variant), getLogoFile(variant)].filter(Boolean);
  await message.channel.send({ embeds: [embed], components, files });
  await message.delete().catch(() => {}); // ลบข้อความคำสั่งทิ้ง (ถ้าบอทมีสิทธิ์)
}

// คำสั่งแอดมินแบบ prefix: handler(message, args, body)
//   args = คำที่ตามหลังชื่อคำสั่งในบรรทัดแรก, body = ข้อความตั้งแต่บรรทัดที่ 2 ลงไป
export const commandHandlers = {
  /** !ap createproduct <ชื่อสินค้า> <ราคา> */
  async createproduct(message, args) {
    const price = Number(args.at(-1));
    const name = args.slice(0, -1).join(" ");
    if (!name || !Number.isFinite(price)) {
      return replyStatus(message, "รูปแบบคำสั่งไม่ถูกต้อง", "ใช้แบบนี้: `!ap createproduct <ชื่อสินค้า> <ราคา>`", "error");
    }
    const { success, msg } = await stockManager.createProduct(name, price);
    await replyStatus(message, success ? "สร้างสินค้า" : "เกิดข้อผิดพลาด", msg, success ? "success" : "error");
  },

  /** !ap restock <ชื่อสินค้า> แล้วขึ้นบรรทัดใหม่ใส่สต็อก (หนึ่งบรรทัดต่อชิ้น) และ/หรือแนบไฟล์ .txt */
  async restock(message, args, body) {
    const product = args.join(" ");
    if (!product) {
      return replyStatus(
        message,
        "รูปแบบคำสั่งไม่ถูกต้อง",
        "ใช้แบบนี้:\n```\n!ap restock ชื่อสินค้า\nสต็อกชิ้นที่ 1\nสต็อกชิ้นที่ 2\n```หรือแนบไฟล์ .txt (UTF-8) หนึ่งบรรทัดต่อหนึ่งชิ้น",
        "error",
      );
    }

    const linesToAdd = [];
    if (body.trim()) linesToAdd.push(...body.split("\n"));
    const attachment = message.attachments.first();
    if (attachment) {
      try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const content = new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
        linesToAdd.push(...content.split("\n"));
      } catch {
        return replyStatus(message, "อ่านไฟล์แนบไม่สำเร็จ", "กรุณาตรวจสอบว่าไฟล์เป็น .txt ที่เข้ารหัส UTF-8", "error");
      }
    }

    if (linesToAdd.length === 0) {
      return replyStatus(message, "ไม่มีข้อมูล", "กรุณาใส่สต็อกในบรรทัดถัดไปหรือแนบไฟล์ .txt", "error");
    }

    const { success, msg } = await stockManager.addStockLines(product, linesToAdd);
    await replyStatus(message, success ? "เติมสต็อกสำเร็จ" : "เกิดข้อผิดพลาด", msg, success ? "success" : "error");
  },

  /** !ap postshop */
  async postshop(message) {
    await postShopPanel(message);
  },

  /** !ap postshop2 */
  async postshop2(message) {
    await postShopPanel(message, "second");
  },

  ...licenseCommands,

  /** !ap help */
  async help(message) {
    const embed = makeStatusEmbed(
      "คำสั่งแอดมิน",
      [
        "`!ap createproduct <ชื่อสินค้า> <ราคา>` — สร้างสินค้าใหม่",
        "`!ap restock <ชื่อสินค้า>` + สต็อกบรรทัดถัดไป หรือแนบไฟล์ .txt — เติมสต็อก",
        "`!ap postshop` / `!ap postshop2` — โพสต์แผงร้านค้า",
        ...licenseHelp,
      ].join("\n"),
      "info",
    );
    await message.reply({ embeds: [embed] });
  },
};

/** ตัวกลางรับคำสั่ง !ap — ใช้ได้เฉพาะในเซิร์ฟเวอร์และเฉพาะแอดมิน */
export async function dispatchMessage(message) {
  if (message.author.bot || !message.inGuild()) return;
  const [firstLine, ...rest] = message.content.split("\n");
  const [prefix, rawName, ...args] = firstLine.trim().split(/\s+/);
  if (prefix?.toLowerCase() !== PREFIX) return;

  try {
    if (!isAdmin(message.author.id)) {
      return await replyStatus(message, "ไม่มีสิทธิ์ใช้งาน", "คำสั่งนี้ใช้ได้เฉพาะแอดมินเท่านั้น", "error");
    }
    const name = (rawName || "help").toLowerCase();
    const handler = Object.hasOwn(commandHandlers, name) ? commandHandlers[name] : commandHandlers.help;
    await handler(message, args, rest.join("\n"));
  } catch (err) {
    const known = adminErrorMessage(err);
    if (!known) console.error("Command error:", err);
    await replyStatus(message, "เกิดข้อผิดพลาด", known ?? "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง", "error").catch(() => {});
  }
}

/** ตัวกลางรับ interaction ทุกชนิด — ถ้าเกิด error จะแจ้งผู้ใช้แทนที่จะค้างที่ "กำลังคิด..." */
export async function dispatchInteraction(interaction) {
  try {
    if (await handleLicenseInteraction(interaction)) return;
    if (interaction.isStringSelectMenu() && [SELECT_ID, SELECT_ID_2].includes(interaction.customId)) {
      await handleProductSelect(interaction);
    } else if (interaction.isButton() && interaction.customId === RELOAD_ID) {
      await handleReload(interaction);
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
      await handlePurchaseSubmit(interaction);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const payload = {
      embeds: [makeStatusEmbed("เกิดข้อผิดพลาด", "ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง", "error")],
      flags: EPHEMERAL,
    };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      /* ตอบไม่ได้แล้ว (เช่น interaction หมดอายุ) */
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  // เปลี่ยนมาใช้คำสั่ง !ap แล้ว — ลบ slash command เก่าที่เคยลงทะเบียนไว้
  await c.application.commands.set([]);
  console.log(`🔄 ใช้คำสั่ง ${PREFIX} (พิมพ์ ${PREFIX} help เพื่อดูคำสั่งทั้งหมด)`);
});
client.on(Events.MessageCreate, dispatchMessage);
client.on(Events.InteractionCreate, dispatchInteraction);

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

// รันบอทเมื่อสั่ง `node index.js` เท่านั้น (ถ้าถูก import ไปทดสอบจะไม่ login)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!BOT_TOKEN) {
    console.error("❌ ไม่พบ BOT_TOKEN — สร้างไฟล์ .env แล้วใส่ BOT_TOKEN=โทเคนบอท (ดูตัวอย่างใน .env.example)");
    process.exit(1);
  }
  client.login(BOT_TOKEN).catch((err) => {
    if (/disallowed intents/i.test(err.message)) {
      console.error(
        "❌ บอทยังไม่ได้เปิด Message Content Intent (จำเป็นสำหรับคำสั่ง !ap)\n" +
          "   ไปที่ https://discord.com/developers/applications → เลือกบอท → Bot → Privileged Gateway Intents\n" +
          "   → เปิด MESSAGE CONTENT INTENT → Save Changes แล้วรันใหม่",
      );
    } else {
      console.error("❌ Login ไม่สำเร็จ:", err);
    }
    process.exit(1);
  });
}
