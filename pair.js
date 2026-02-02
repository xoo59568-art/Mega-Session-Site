import express from "express";
import fs from "fs";
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

/* ---------------- helpers ---------------- */

function removeFile(path) {
  try {
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  } catch (e) {
    console.log("Cleanup error:", e.message);
  }
}

// Node 18+ / 20 built-in fetch (Render safe)
async function getImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Image download failed");
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function getMegaFileId(url) {
  const match = url?.match(/\/file\/([^#]+#[^\/]+)/);
  return match ? match[1] : null;
}

/* ---------------- route ---------------- */

router.get("/", async (req, res) => {
  let num = req.query.number;
  if (!num) return res.status(400).send({ code: "Number required" });

  num = num.replace(/[^0-9]/g, "");
  const phone = pn("+" + num);

  if (!phone.isValid()) {
    return res.status(400).send({
      code: "Invalid international number",
    });
  }

  num = phone.getNumber("e164").replace("+", "");
  const sessionDir = "./" + num;

  removeFile(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let pairSent = false;
  let dpDone = false;

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

  /* ---------------- connection events ---------------- */

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    // ✅ Pair completed
    if (connection === "open" && !dpDone) {
      dpDone = true;
      console.log("✅ Pair completed");

      try {
        await delay(3000);

        // 🔹 DP image
        const imgUrl = "https://files.catbox.moe/d8z5wt.jpg";
        const imgBuffer = await getImageBuffer(imgUrl);

        // 🔹 Set profile picture
        await sock.updateProfilePicture(sock.user.id, imgBuffer);

        // 🔔 Notification
        await sock.sendMessage(sock.user.id, {
          text: "🖼️ Profile picture updated successfully ✅",
        });

        console.log("🖼️ DP updated & notification sent");

        // 🔹 Upload creds to MEGA
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
        console.log("❌ Post-pair error:", e.message);
      }
    }

    // reconnect info
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== 401) {
        console.log("🔁 Connection closed, waiting...");
      }
    }
  });

  /* ---------------- pairing code ---------------- */

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
        res.status(503).send({ code: "Pairing failed" });
      }
    }
  }
});

export default router;

/* ---------------- safety ---------------- */

process.on("uncaughtException", (err) => {
  const e = String(err);
  if (
    e.includes("conflict") ||
    e.includes("not-authorized") ||
    e.includes("Timed Out") ||
    e.includes("rate-overlimit")
  )
    return;
  console.log("Unhandled exception:", err);
});
