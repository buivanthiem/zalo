
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Zalo } = require("zalo-api-final");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || "/zalo";
const PROXY = process.env.PROXY || "";
const SESSION_DIR = path.join(process.cwd(), "sessions");

// đảm bảo có thư mục
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ================= HELPER =================
function getSessionPath(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function saveSession(sessionId, data) {
  fs.writeFileSync(getSessionPath(sessionId), JSON.stringify(data, null, 2));
}

function loadSession(sessionId) {
  const file = getSessionPath(sessionId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file));
}

function deleteSession(sessionId) {
  const file = getSessionPath(sessionId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ================= ROUTER =================
const router = express.Router();

/**
 * POST /login/qr
 */
router.post("/login/qr", async (req, res) => {
  const proxy = req.body.proxy || PROXY || "";
  const sessionId = Date.now().toString();

  let resolveQR, rejectQR;
  let isDone = false;

  const qrPromise = new Promise((resolve, reject) => {
    resolveQR = (data) => {
      if (!isDone) {
        isDone = true;
        resolve(data);
      }
    };
    rejectQR = (err) => {
      if (!isDone) {
        isDone = true;
        reject(err);
      }
    };
  });

  try {
    const zaloOptions = { selfListen: true, logging: false };
    if (proxy) zaloOptions.proxy = proxy;

    const zalo = new Zalo(zaloOptions);

    // tạo session ban đầu
    let session = {
      status: "pending",
      userInfo: null,
      credentials: null,
    };

    saveSession(sessionId, session);

    // timeout QR
    const timeoutId = setTimeout(() => {
      deleteSession(sessionId);
      rejectQR(new Error("Timeout tạo QR"));
    }, 60000);

    // login QR
    zalo.loginQR(null, (qrEvent) => {
      let s = loadSession(sessionId);
      if (!s) return;

      console.log("EVENT:", qrEvent.type);

      switch (qrEvent.type) {
        case 0: // QR
          if (qrEvent?.data?.image) {
            clearTimeout(timeoutId);
            s.status = "waiting_scan";
            saveSession(sessionId, s);
            resolveQR(qrEvent.data.image);
          }
          break;

        case 1: // expired
          s.status = "expired";
          saveSession(sessionId, s);
          break;

        case 2: // scanned
          s.status = "scanned";
          if (qrEvent?.data) {
            s.userInfo = {
              name: qrEvent.data.display_name,
              avatar: qrEvent.data.avatar,
            };
          }
          saveSession(sessionId, s);
          break;

        case 3: // declined
          s.status = "declined";
          saveSession(sessionId, s);
          break;

        case 4: // success
          if (qrEvent?.data) {
            s.status = "success";
            s.credentials = {
              cookie: JSON.stringify(qrEvent.data.cookie || []),
              imei: qrEvent.data.imei || "",
              userAgent: qrEvent.data.userAgent || "",
              proxy: proxy || "",
            };
            saveSession(sessionId, s);
            console.log(`[${sessionId}] Saved credentials`);
          }
          break;
      }
    })
    .then((api) => {
      api.listener.start();

      api.listener.onConnected(() => {
        console.log(`[${sessionId}] Connected`);
      });

      api.listener.onError((err) => {
        console.error(`[${sessionId}] Error:`, err);
      });
    })
    .catch((err) => {
      rejectQR(err);
    });

    const qrBase64 = await qrPromise;

    res.json({
      success: true,
      sessionId,
      qr: qrBase64,
    });

  } catch (err) {
    deleteSession(sessionId);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /login/status/:sessionId
 */
router.get("/login/status/:sessionId", (req, res) => {
  const session = loadSession(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Session không tồn tại",
    });
  }

  if (session.status === "success") {
    return res.json({
      success: true,
      status: "success",
      credentials: session.credentials,
    });
  }

  res.json({
    success: true,
    status: session.status,
    userInfo: session.userInfo,
  });
});

// ================= ROUTE =================
app.use(BASE_PATH, router);

app.get("/", (req, res) => {
  res.send("Zalo QR Login Server Running 🚀");
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`✅ Server running at port ${PORT}`);
  console.log(`👉 Base path: ${BASE_PATH}`);
});
