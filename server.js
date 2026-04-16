const express = require("express");
const fs = require("fs");
const path = require("path");
const { Zalo } = require("zalo-api-final");

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.use(cors({
  origin: [
    "https://ca.futurehomes.vn",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));
app.options("*", cors());

// 🔥 CONFIG
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || "/zalo"; // cPanel dùng /zalo
const PROXY = process.env.PROXY || "";

// Session in-memory (MVP)
const sessions = new Map();

// Cleanup session sau 5 phút
function autoCleanup(sessionId) {
  setTimeout(() => {
    const session = sessions.get(sessionId);
    if (session) {
      console.log(`[${sessionId}] Auto cleanup`);
      try {
        session.api?.listener?.stop();
      } catch {}
      sessions.delete(sessionId);
    }
  }, 5 * 60 * 1000);
}

// ─────────────────────────────
// ROUTER
// ─────────────────────────────
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

    const session = {
      status: "pending",
      credentials: null,
      userInfo: null,
      api: null,
    };

    sessions.set(sessionId, session);
    autoCleanup(sessionId);

    // Timeout QR
    const timeoutId = setTimeout(() => {
      rejectQR(new Error("Timeout tạo QR"));
      sessions.delete(sessionId);
    }, 60000);

    // Login QR
    zalo
      .loginQR(null, (qrEvent) => {
        const s = sessions.get(sessionId);
        if (!s) return;

        switch (qrEvent.type) {
          case 0: // QR
            if (qrEvent?.data?.image) {
              clearTimeout(timeoutId);
              resolveQR(qrEvent.data.image);
              s.status = "waiting_scan";
            }
            break;

          case 1: // expired
            s.status = "expired";
            break;

          case 2: // scanned
            s.status = "scanned";
            if (qrEvent?.data) {
              s.userInfo = {
                name: qrEvent.data.display_name,
                avatar: qrEvent.data.avatar,
              };
            }
            break;

          case 3: // declined
            s.status = "declined";
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

              // 🔥 Lưu theo sessionId (không ghi đè)
              const filePath = path.join(
                __dirname,
                "sessions",
                `${sessionId}.json`
              );

              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, JSON.stringify(s.credentials, null, 2));

              console.log(`[${sessionId}] Saved credentials`);
            }
            break;
        }

        sessions.set(sessionId, s);
      })
      .then((api) => {
        const s = sessions.get(sessionId);
        if (!s) return;

        s.api = api;

        api.listener.start();
        api.listener.onConnected(() =>
          console.log(`[${sessionId}] Connected`)
        );
        api.listener.onError((err) =>
          console.error(`[${sessionId}] Zalo error:`, err)
        );
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
    sessions.delete(sessionId);
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
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Session không tồn tại",
    });
  }

  if (session.status === "success") {
    const credentials = session.credentials;

    // cleanup luôn
    try {
      session.api?.listener?.stop();
    } catch {}

    sessions.delete(req.params.sessionId);

    return res.json({
      success: true,
      status: "success",
      credentials,
    });
  }

  res.json({
    success: true,
    status: session.status,
    userInfo: session.userInfo,
  });
});

// Gắn base path (QUAN TRỌNG)
app.use(BASE_PATH, router);

// Root check
app.get("/", (req, res) => {
  res.send("Zalo QR Login Server Running 🚀");
});

// Start server
app.listen(PORT, () => {
  console.log(`\n✅ Server running at port ${PORT}`);
  console.log(`👉 Base path: ${BASE_PATH}`);
});
