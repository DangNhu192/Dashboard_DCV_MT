# 🏛️ Hệ Thống Theo Dõi, Tra Cứu & Cảnh Báo Hồ Sơ Một Cửa (Web & PWA)

> Phiên bản Web & PWA triển khai thông qua **Vercel** — Đầy đủ giao diện, tính năng và logic tính hạn chuẩn xác 100% tương đương với bản Desktop `.exe` và Tiện ích trình duyệt Chrome Extension.

---

## 🌟 ĐẶC ĐIỂM NỔI BẬT

1. **Giao diện & Nghiệp vụ đồng nhất 100%**:
   - Sử dụng chung bộ mã lõi nghiệp vụ `core.js` và đồ thị thống kê `charts.js`.
   - Bảng Cảnh báo tiến độ phân cấp trực quan: 🔴 **HẾT HẠN** và 🟡 **SẮP HẾT HẠN**.
   - Cột **Thời gian còn lại**: hiển thị tỷ lệ thực tế `Còn lại / Tổng ngày quy định` (ví dụ `Còn 1.5 / 15 ngày`).
   - Hỗ trợ đối soát hạn chính xác đến từng giây `dd/mm/yyyy hh:mm:ss`.
   - Nút **"🌐 Mở trên Một Cửa"** trong hộp thoại chi tiết: mở trực tiếp kết quả tra cứu mã hồ sơ trên Cổng Một Cửa điện tử ngành Nông nghiệp & Môi trường (`motcuannmt.mae.gov.vn`).
   - Tùy biến vị trí tất cả các cột dữ liệu (A–Z, AA–AZ...) và giám sát quy trình từng bước (Step Tracking & Delay Bottleneck).
2. **Serverless Proxy vượt rào cản CORS (`api/proxy.js`)**:
   - Vercel Serverless Function trung gian tải CSV từ Google Sheets, giúp trình duyệt đọc bảng tính mượt mà mà không bao giờ bị lỗi CORS (Cross-Origin Resource Sharing).
3. **Lưu trữ cá nhân hóa độc lập (localStorage)**:
   - Dữ liệu cấu hình (Link Sheet, chu kỳ, cột ánh xạ, ngày nghỉ...) được lưu trong bộ nhớ trình duyệt của từng cán bộ.
   - Hoàn toàn miễn phí 0đ, không cần cài đặt hoặc thuê Database phức tạp.
   - Hỗ trợ nút **"📤 Xuất cấu hình"** và **"📥 Nhập cấu hình"** (JSON) để sao lưu hoặc chuyển đổi cấu hình sang máy khác trong 1 giây.
4. **Chuẩn PWA (Progressive Web App) & Web Notifications**:
   - Bấm nút **"📲 Cài App PWA"** trên thanh công cụ để cài ứng dụng lên màn hình máy tính (Windows/macOS) hoặc điện thoại (Android/iOS) như một phần mềm độc lập.
   - Bật thông báo đẩy trên trình duyệt để nhận cảnh báo nổi trên góc màn hình khi có hồ sơ đến hạn.

---

## 🚀 HƯỚNG DẪN ĐƯA LÊN GITHUB & DEPLOY VERCEL

### Cách 1: Đưa riêng thư mục `web-app` lên GitHub (Khuyên dùng)

1. Mở Terminal (PowerShell / Command Prompt) tại thư mục `web-app`:
   ```bash
   cd "I:\My Drive\AppSheet\UNGDUNGWEB\Script nhắc hạn\web-app"
   ```

2. Khởi tạo Git và đưa lên GitHub:
   ```bash
   git init
   git add .
   git commit -m "feat: Initial commit Ho So Mot Cua Web PWA for Vercel"
   git branch -M main
   git remote add origin https://github.com/TÊN_GITHUB_CỦA_BẠN/ho-so-mot-cua-web.git
   git push -u origin main
   ```
   *(Thay `TÊN_GITHUB_CỦA_BẠN` bằng tài khoản GitHub của bạn)*

3. Triển khai lên Vercel:
   - Truy cập **[vercel.com](https://vercel.com)** và đăng nhập bằng tài khoản GitHub.
   - Bấm **"Add New..."** → chọn **"Project"**.
   - Tìm kho mã `ho-so-mot-cua-web` vừa đẩy lên và bấm **"Import"**.
   - Ở mục **Framework Preset**, chọn `Other` (hoặc để mặc định).
   - Bấm nút **"Deploy"**.
   - Sau ~30 giây, Vercel sẽ cấp cho bạn một đường link trực tuyến (ví dụ: `https://ho-so-mot-cua-web.vercel.app`) sẵn sàng hoạt động cho toàn cơ quan/đơn vị sử dụng!

---

### Cách 2: Triển khai trực tiếp bằng Vercel CLI (Không cần qua GitHub)

Nếu bạn đã cài sẵn Node.js và Vercel CLI:
```bash
cd "I:\My Drive\AppSheet\UNGDUNGWEB\Script nhắc hạn\web-app"
npx vercel
```
Làm theo các hướng dẫn trên màn hình (Enter chọn mặc định), ứng dụng sẽ lập tức được triển khai lên Vercel.

---

## 📁 CẤU TRÚC THƯ MỤC DỰ ÁN

```text
web-app/
├── api/
│   └── proxy.js             # Vercel Serverless Function trung gian tải Google Sheets (vượt CORS)
├── public/
│   ├── icons/               # Bộ biểu tượng ứng dụng PWA (16, 48, 128, 192, 512px)
│   ├── manifest.json        # Cấu hình PWA Web App Manifest
│   └── sw.js                # Service Worker lưu cache và kích hoạt thông báo
├── index.html               # Giao diện chính ứng dụng (HTML/CSS chuẩn Awwwards/Bento)
├── core.js                  # Thư viện tính toán ngày hạn, xử lý CSV dùng chung
├── charts.js                # Thư viện vẽ biểu đồ thống kê Chart.js
├── app.js                   # Bộ điều khiển giao diện Web, localStorage, Web Notification
├── vercel.json              # Cấu hình định tuyến máy chủ Vercel
├── package.json             # Thông tin gói dự án
├── .gitignore               # Tệp loại trừ cho Git
└── README.md                # Tài liệu hướng dẫn sử dụng và triển khai
```

---

## 🔒 AN TOÀN & BẢO MẬT

- **API Proxy**: Hàm `api/proxy.js` chỉ cho phép chuyển tiếp yêu cầu đến miền `https://docs.google.com/spreadsheets/d/`, chặn đứng hoàn toàn việc lợi dụng proxy để gọi sang các trang web khác.
- **Dữ liệu cục bộ**: Mọi thông tin danh sách hồ sơ, tên người nộp, số điện thoại đều chỉ lưu trong `localStorage` tại trình duyệt của người dùng, không bao giờ gửi ra bất kỳ máy chủ bên thứ ba nào.

---

> 🏢 **Hệ Thống Theo Dõi Hồ Sơ Một Cửa** — *Đồng hành cùng nền hành chính công hiện đại, minh bạch và đúng hạn.*
