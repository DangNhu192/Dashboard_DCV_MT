/**
 * Vercel Serverless Function: Proxy tải dữ liệu CSV từ Google Sheets
 * Giúp vượt rào cản CORS của trình duyệt khi chạy ứng dụng trên môi trường Web / Vercel.
 */

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Only GET is supported." });
  }

  const targetUrl = req.query.url;

  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).send("Thiếu tham số url.");
  }

  // Bảo mật: Chỉ cho phép tải từ Google Spreadsheets
  try {
    const parsed = new URL(targetUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "docs.google.com" ||
      !parsed.pathname.startsWith("/spreadsheets/d/")
    ) {
      return res.status(400).send("Chỉ cho phép tải dữ liệu từ https://docs.google.com/spreadsheets/");
    }
  } catch (e) {
    return res.status(400).send("URL không hợp lệ: " + e.message);
  }

  // Tải dữ liệu với timeout 25 giây
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const fetchRes = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HoSoMotCuaWeb/1.1.1 (Vercel-Proxy)"
      }
    });

    clearTimeout(timeoutId);

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).send(`Google Sheets phản hồi mã lỗi HTTP ${fetchRes.status}`);
    }

    const text = await fetchRes.text();

    // Kiểm tra xem phản hồi có phải trang đăng nhập Google hay không
    if (
      text.includes("<!DOCTYPE") &&
      (text.includes("accounts.google.com") || text.includes("ServiceLogin") || text.includes("Google Accounts"))
    ) {
      return res.status(403).send(
        "Bảng tính Google Sheets chưa được mở quyền xem công khai (Ai có liên kết cũng có thể xem). Vui lòng kiểm tra quyền chia sẻ của Sheet."
      );
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.status(200).send(text);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return res.status(504).send("Quá thời gian kết nối tới Google Sheets (Timeout 25s).");
    }
    return res.status(502).send("Lỗi kết nối tới máy chủ Google Sheets: " + err.message);
  }
};
