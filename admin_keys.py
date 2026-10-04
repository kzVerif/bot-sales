"""จัดการ License Key (สำหรับผู้ขายเท่านั้น — ห้ามส่งไฟล์นี้และ admin_secret.txt ให้ลูกค้า)

ต้องมี Supabase secret key (sb_secret_...) ใน admin_secret.txt หรือ env SUPABASE_SECRET_KEY

ตัวอย่าง:
  py admin_keys.py gen 1d --note "ลูกค้า A"        สร้างคีย์ 1 วัน
  py admin_keys.py gen 7d --count 5               สร้างคีย์ 7 วัน 5 อัน
  py admin_keys.py gen 30d --plan pro             สร้างคีย์แพ็กเกจ Pro (รันพร้อมกัน 5 บัญชี)
  py admin_keys.py gen 30d --plan pro --accounts 10   Pro แบบกำหนดจำนวนบัญชีเอง
  py admin_keys.py plan APF-XXXX-... plus         เปลี่ยนแพ็กเกจของคีย์ (basic / plus / pro)
  py admin_keys.py list                           ดูคีย์ทั้งหมด
  py admin_keys.py info APF-XXXX-...              ดูรายละเอียดคีย์
  py admin_keys.py extend APF-XXXX-... 3d         ต่ออายุ 3 วัน
  py admin_keys.py reset-hwid APF-XXXX-...        ให้ลูกค้าย้ายไปใช้เครื่องใหม่ (เวลาเดินต่อ)
  py admin_keys.py revoke APF-XXXX-...            ยกเลิกคีย์
  py admin_keys.py restore APF-XXXX-...           เปิดใช้คีย์ที่ยกเลิกไปแล้วอีกครั้ง

อัปเดต / ประกาศ (ต้องรัน supabase/app_info.sql ก่อน):
  py admin_keys.py app-info                       ดูเวอร์ชันล่าสุดและประกาศที่ตั้งไว้
  py admin_keys.py release 1.0.1 --url LINK --notes "แก้ปุ่มโพสต์"     แจ้งลูกค้าว่ามีเวอร์ชันใหม่
  py admin_keys.py release 1.0.1 --url LINK --force                  บังคับให้อัปเดตก่อนใช้งาน
  py admin_keys.py announce "เฟซเปลี่ยนหน้า กำลังแก้" --level warn   ประกาศถึงลูกค้าทุกคน
  py admin_keys.py announce --clear               ลบประกาศ

ระยะเวลา: 12h = 12 ชั่วโมง, 1d = 1 วัน, 2w = 2 สัปดาห์
แพ็กเกจ: basic = รันพร้อมกัน 1 บัญชี (ค่าเริ่มต้น), plus = 2 บัญชี, pro = 5 บัญชี (เปลี่ยนจำนวนด้วย --accounts)
"""
import argparse
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from licensing import PLANS, SUPABASE_URL, normalize_key, plan_label

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SECRET_FILE = os.path.join(BASE_DIR, "admin_secret.txt")
KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # ตัด 0/O/1/I ที่อ่านสับสน
BKK = timezone(timedelta(hours=7))

def load_secret():
    secret = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not secret and os.path.isfile(SECRET_FILE):
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            secret = f.read().strip()
    if not secret:
        sys.exit(f"[!] ไม่พบ secret key — ใส่ sb_secret_... ไว้ในไฟล์ {SECRET_FILE}\n"
                 "    (Supabase Dashboard → Project Settings → API Keys → Secret keys)")
    return secret

def api(method, path, body=None, prefer=None):
    secret = load_secret()
    headers = {"apikey": secret, "Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "autopost-fb-admin/1.0"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        if "max_accounts" in detail:  # ยังไม่ได้เพิ่มคอลัมน์แพ็กเกจ (v1.2.0)
            sys.exit("[!] ตาราง licenses ยังไม่มีคอลัมน์แพ็กเกจ — รัน supabase/license.sql อีกครั้งใน SQL Editor "
                     "(รันซ้ำได้ ข้อมูลคีย์เดิมไม่หาย)")
        if "PGRST205" in detail:  # ไม่พบตาราง
            table = "app_info" if path.startswith("app_info") else "licenses"
            sys.exit(f"[!] ยังไม่มีตาราง {table} — รัน supabase/{'app_info' if table == 'app_info' else 'license'}.sql "
                     "ใน Supabase SQL Editor ก่อน")
        sys.exit(f"[!] Supabase ตอบกลับ HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"[!] เชื่อมต่อ Supabase ไม่ได้: {e}")
    return json.loads(raw) if raw else None

def parse_duration(text):
    match = re.fullmatch(r"(\d+)\s*([hdw])", text.strip().lower())
    if not match or int(match.group(1)) <= 0:
        sys.exit(f"[!] ระยะเวลาไม่ถูกต้อง: {text} (ใช้เช่น 12h, 1d, 7d, 2w)")
    value, unit = int(match.group(1)), match.group(2)
    return value * {"h": 1, "d": 24, "w": 24 * 7}[unit]

def fmt_hours(hours):
    days, rest = divmod(hours, 24)
    if days and rest:
        return f"{days} วัน {rest} ชม."
    return f"{days} วัน" if days else f"{rest} ชม."

def parse_ts(value):
    return datetime.fromisoformat(value) if value else None

def fmt_ts(value):
    ts = parse_ts(value)
    return ts.astimezone(BKK).strftime("%d/%m/%Y %H:%M") if ts else "-"

def new_key():
    groups = ["".join(secrets.choice(KEY_ALPHABET) for _ in range(4)) for _ in range(4)]
    return "APF-" + "-".join(groups)

def status_of(row):
    if row["status"] == "revoked":
        return "ยกเลิกแล้ว"
    if not row["activated_at"]:
        return "ยังไม่ได้ใช้"
    left = parse_ts(row["expires_at"]) - datetime.now(timezone.utc)
    if left.total_seconds() <= 0:
        return "หมดอายุ"
    hours = int(left.total_seconds() // 3600)
    return f"ใช้งานอยู่ (เหลือ {fmt_hours(hours) if hours else str(int(left.total_seconds() // 60)) + ' นาที'})"

def get_row(key):
    rows = api("GET", f"licenses?key=eq.{urllib.parse.quote(normalize_key(key))}&select=*")
    if not rows:
        sys.exit(f"[!] ไม่พบคีย์ {key}")
    return rows[0]

def update_row(key, fields):
    rows = api("PATCH", f"licenses?key=eq.{urllib.parse.quote(key)}", fields, prefer="return=representation")
    return rows[0]

def print_row(row):
    print(f"  คีย์         : {row['key']}")
    print(f"  สถานะ       : {status_of(row)}")
    print(f"  ระยะเวลา     : {fmt_hours(row['duration_hours'])}")
    print(f"  แพ็กเกจ      : {plan_label(row.get('max_accounts'))}")
    print(f"  เริ่มใช้       : {fmt_ts(row['activated_at'])}")
    print(f"  หมดอายุ      : {fmt_ts(row['expires_at'])}")
    print(f"  ผูกเครื่อง     : {row['hwid'][:16].upper() if row['hwid'] else '-'}")
    print(f"  ใช้ล่าสุด      : {fmt_ts(row['last_seen_at'])}")
    print(f"  หมายเหตุ     : {row['note'] or '-'}")

# ---------------------------------------------------------------- commands
def cmd_gen(args):
    hours = parse_duration(args.duration)
    accounts = plan_accounts(args)
    rows = [{"key": new_key(), "duration_hours": hours, "note": args.note, "max_accounts": accounts}
            for _ in range(args.count)]
    created = api("POST", "licenses", rows, prefer="return=representation")
    print(f"[+] สร้างคีย์ {fmt_hours(hours)} แพ็กเกจ {plan_label(accounts)} จำนวน {len(created)} อัน "
          "(เริ่มนับเวลาเมื่อลูกค้าใช้คีย์ครั้งแรก)\n")
    for row in created:
        print(f"  {row['key']}")

def cmd_list(args):
    rows = api("GET", "licenses?select=*&order=created_at.desc")
    if not args.all:
        rows = [r for r in rows if status_of(r) not in ("หมดอายุ", "ยกเลิกแล้ว")]
    if not rows:
        print("ไม่มีคีย์" + ("" if args.all else " (ใช้ --all เพื่อดูคีย์ที่หมดอายุ/ยกเลิกแล้วด้วย)"))
        return
    for row in rows:
        plan = plan_label(row.get("max_accounts")).split(" · ")[0]
        print(f"  {row['key']}  {fmt_hours(row['duration_hours']):>9}  {plan:<8}  {status_of(row):<28}  {row['note'] or ''}")
    print(f"\nทั้งหมด {len(rows)} คีย์" + ("" if args.all else " (ซ่อนคีย์ที่หมดอายุ/ยกเลิกแล้ว — ใช้ --all เพื่อดูทั้งหมด)"))

def cmd_info(args):
    print_row(get_row(args.key))

def cmd_extend(args):
    row = get_row(args.key)
    hours = parse_duration(args.duration)
    fields = {"duration_hours": row["duration_hours"] + hours}
    if row["expires_at"]:
        # หมดอายุไปแล้ว = นับต่อจากตอนนี้, ยังไม่หมด = บวกต่อจากวันหมดอายุเดิม
        base = max(parse_ts(row["expires_at"]), datetime.now(timezone.utc))
        fields["expires_at"] = (base + timedelta(hours=hours)).isoformat()
    row = update_row(row["key"], fields)
    print(f"[+] ต่ออายุ {fmt_hours(hours)} แล้ว\n")
    print_row(row)

def plan_accounts(args):
    """จำนวนบัญชีจาก --plan / --accounts (--accounts ชนะ)"""
    accounts = args.accounts if args.accounts is not None else PLANS[args.plan]
    if not 1 <= accounts <= 50:
        sys.exit("[!] --accounts ต้องอยู่ระหว่าง 1–50")
    return accounts

def cmd_plan(args):
    accounts = plan_accounts(args)
    row = update_row(get_row(args.key)["key"], {"max_accounts": accounts})
    print(f"[+] เปลี่ยนเป็นแพ็กเกจ {plan_label(accounts)} แล้ว — โปรแกรมลูกค้าจะใช้ค่าใหม่ภายใน 10 นาที (หรือทันทีที่เปิดใหม่)\n")
    print_row(row)

def cmd_reset_hwid(args):
    row = update_row(get_row(args.key)["key"], {"hwid": None})
    print("[+] ปลดเครื่องแล้ว — ลูกค้าใส่คีย์เดิมในเครื่องใหม่ได้เลย (เวลาที่เหลือเดินต่อ)\n")
    print_row(row)

def cmd_revoke(args):
    row = update_row(get_row(args.key)["key"], {"status": "revoked"})
    print("[+] ยกเลิกคีย์แล้ว — โปรแกรมลูกค้าจะหยุดภายใน 10 นาที\n")
    print_row(row)

def cmd_restore(args):
    row = update_row(get_row(args.key)["key"], {"status": "active"})
    print("[+] เปิดใช้คีย์อีกครั้งแล้ว\n")
    print_row(row)

def get_app_info():
    rows = api("GET", "app_info?id=eq.1&select=*")
    if not rows:
        sys.exit("[!] ไม่พบตาราง app_info — รัน supabase/app_info.sql ใน SQL Editor ก่อน")
    return rows[0]

def update_app_info(fields):
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    return api("PATCH", "app_info?id=eq.1", fields, prefer="return=representation")[0]

def print_app_info(info):
    print(f"  เวอร์ชันล่าสุด    : {info['latest_version']}")
    print(f"  ขั้นต่ำที่ใช้ได้     : {info['min_version']}  (ต่ำกว่านี้ = บังคับอัปเดต)")
    print(f"  ลิงก์ดาวน์โหลด   : {info['download_url'] or '-'}")
    print(f"  สิ่งที่เปลี่ยน       : {info['changelog'] or '-'}")
    level = {"info": "ทั่วไป", "warn": "เตือน", "critical": "สำคัญมาก"}[info["announcement_level"]]
    print(f"  ประกาศ          : {info['announcement'] + f'  [{level}]' if info['announcement'] else '-'}")

def cmd_app_info(args):
    print_app_info(get_app_info())

def cmd_release(args):
    from updates import parse_version
    current = get_app_info()
    if parse_version(args.version) < parse_version(current["latest_version"]):
        sys.exit(f"[!] {args.version} เก่ากว่าเวอร์ชันล่าสุดที่ประกาศไว้ ({current['latest_version']})")
    if not args.url.startswith(("https://", "http://")):
        sys.exit("[!] --url ต้องขึ้นต้นด้วย https://")
    fields = {"latest_version": args.version, "download_url": args.url, "changelog": args.notes}
    if args.force:
        fields["min_version"] = args.version
    info = update_app_info(fields)
    print(f"[+] ประกาศเวอร์ชัน {args.version} แล้ว — โปรแกรมลูกค้าจะเห็นภายใน 30 นาที (หรือทันทีที่เปิดใหม่)")
    if args.force:
        print("    เวอร์ชันเก่าจะกดเริ่มทำงานไม่ได้จนกว่าจะอัปเดต")
    print()
    print_app_info(info)

def cmd_announce(args):
    if args.clear:
        info = update_app_info({"announcement": None, "announcement_at": None})
        print("[+] ลบประกาศแล้ว\n")
    else:
        if not args.text:
            sys.exit('[!] ใส่ข้อความประกาศ เช่น announce "ข้อความ" หรือใช้ --clear')
        info = update_app_info({"announcement": args.text, "announcement_level": args.level,
                                "announcement_at": datetime.now(timezone.utc).isoformat()})
        print("[+] ประกาศแล้ว — โปรแกรมลูกค้าจะเห็นภายใน 30 นาที (หรือทันทีที่เปิดใหม่)\n")
    print_app_info(info)

def main():
    sys.stdout.reconfigure(encoding="utf-8")  # ให้ภาษาไทยแสดงใน Terminal ได้
    parser = argparse.ArgumentParser(description="จัดการ License Key ของ Auto Post FB")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("gen", help="สร้างคีย์ใหม่")
    p.add_argument("duration", help="ระยะเวลา เช่น 12h, 1d, 7d, 30d")
    p.add_argument("--count", type=int, default=1, help="จำนวนคีย์ (ค่าเริ่มต้น 1)")
    p.add_argument("--note", default=None, help="หมายเหตุ เช่น ชื่อลูกค้า")
    p.add_argument("--plan", choices=tuple(PLANS), default="basic",
                   help="basic = 1 บัญชี (ค่าเริ่มต้น), plus = 2 บัญชี, pro = 5 บัญชี")
    p.add_argument("--accounts", type=int, default=None, help="กำหนดจำนวนบัญชีที่รันพร้อมกันเอง (แทนค่าของแพ็กเกจ)")
    p.set_defaults(func=cmd_gen)

    p = sub.add_parser("plan", help="เปลี่ยนแพ็กเกจของคีย์")
    p.add_argument("key")
    p.add_argument("plan", choices=tuple(PLANS), help="basic / plus / pro")
    p.add_argument("--accounts", type=int, default=None, help="กำหนดจำนวนบัญชีเอง (แทนค่าของแพ็กเกจ)")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("list", help="ดูคีย์ทั้งหมด")
    p.add_argument("--all", action="store_true", help="รวมคีย์ที่หมดอายุ/ยกเลิกแล้ว")
    p.set_defaults(func=cmd_list)

    for name, func, text in (
        ("info", cmd_info, "ดูรายละเอียดคีย์"),
        ("reset-hwid", cmd_reset_hwid, "ปลดเครื่อง ให้ใช้คีย์กับเครื่องใหม่ได้"),
        ("revoke", cmd_revoke, "ยกเลิกคีย์"),
        ("restore", cmd_restore, "เปิดใช้คีย์ที่ยกเลิกไปแล้ว"),
    ):
        p = sub.add_parser(name, help=text)
        p.add_argument("key")
        p.set_defaults(func=func)

    p = sub.add_parser("extend", help="ต่ออายุคีย์")
    p.add_argument("key")
    p.add_argument("duration", help="ระยะเวลาที่เพิ่ม เช่น 1d, 7d")
    p.set_defaults(func=cmd_extend)

    p = sub.add_parser("app-info", help="ดูเวอร์ชันล่าสุดและประกาศ")
    p.set_defaults(func=cmd_app_info)

    p = sub.add_parser("release", help="แจ้งลูกค้าว่ามีเวอร์ชันใหม่")
    p.add_argument("version", help="เลขเวอร์ชัน เช่น 1.0.1 (ต้องตรงกับ version.py ของตัวที่ build)")
    p.add_argument("--url", required=True, help="ลิงก์ดาวน์โหลดไฟล์ zip")
    p.add_argument("--notes", default=None, help="สิ่งที่เปลี่ยนในเวอร์ชันนี้")
    p.add_argument("--force", action="store_true", help="บังคับอัปเดต: เวอร์ชันเก่าใช้งานไม่ได้")
    p.set_defaults(func=cmd_release)

    p = sub.add_parser("announce", help="ประกาศข้อความถึงลูกค้าทุกคน")
    p.add_argument("text", nargs="?", help="ข้อความประกาศ")
    p.add_argument("--level", choices=("info", "warn", "critical"), default="info",
                   help="info = ทั่วไป (ฟ้า), warn = เตือน (ส้ม), critical = สำคัญมาก (แดง)")
    p.add_argument("--clear", action="store_true", help="ลบประกาศ")
    p.set_defaults(func=cmd_announce)

    args = parser.parse_args()
    if getattr(args, "count", 1) < 1:
        sys.exit("[!] --count ต้องมากกว่า 0")
    args.func(args)

if __name__ == "__main__":
    main()
