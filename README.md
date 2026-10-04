# ChatCRM — CRM quản lý tin nhắn Facebook

Giai đoạn 1: **Vào thẳng giao diện CRM — bấm "Đăng nhập bằng Chrome", tự đăng nhập Facebook tay, tool tự bắt cookie + xác nhận cookie live.**

## Cách chạy

```bash
npm install
npm start
```

Trang CRM mở tại **http://localhost:3000** (nếu bận cổng sẽ tự chuyển sang 3001, 3002…) và tự mở trình duyệt.

## Luồng đăng nhập

1. Vào trang CRM luôn — không có màn chặn. Thẻ **"Kết nối tài khoản Facebook"** hiện trạng thái.
2. Bấm **"Đăng nhập bằng Chrome"** → tool mở một cửa sổ Chrome trỏ tới facebook.com.
3. **Bạn tự điền tài khoản & mật khẩu** trong cửa sổ đó — 2FA, checkpoint, xác minh thiết bị… đều làm bình thường như đăng Facebook.
4. Ngay khi vào được tài khoản, tool **tự phát hiện cookie** (`c_user` + `xs`), **xác nhận cookie live** với Facebook, lưu vào hệ thống và đóng cửa sổ Chrome.
5. Giao diện tự chuyển sang trạng thái đã đăng nhập: tên, UID, avatar, badge "Cookie hoạt động", xem/sao chép cookie.

Phương án dự phòng: nếu không mở được Chrome, bấm **"Nhập cookie thủ công"** và dán cookie đã copy từ trình duyệt — hệ thống vẫn xác nhận live trước khi ghi nhận.

## Nhận diện phiên đăng nhập

- Tải lại trang (F5) là vào thẳng dashboard với tài khoản đã kết nối — không cần đăng nhập lại.
- Cookie được kiểm tra lại với Facebook mỗi 5 phút; hết hạn là tự đẩy về trạng thái chưa đăng nhập.
- Nút **"Kiểm tra lại"** kiểm tra cookie thủ công bất cứ lúc nào.
- Phiên "mở Chrome chờ đăng nhập" không bị mất khi F5 — trang sẽ tự nối lại theo dõi.

## Bảo mật & lưu trữ

- Tool **không hề chạm vào mật khẩu** — bạn tự gõ trong cửa sổ Chrome thật của Facebook.
- Cookie lưu tại `data/accounts.json`, phiên lưu tại `data/sessions.json` (chạy cục bộ trên máy bạn — chưa mã hoá, đừng công khai thư mục này).
- Cookie được che (blur) trên giao diện, bấm "Hiện cookie" / "Sao chép" để xem đầy đủ.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng chạy server |
| `FB_AUTO_OPEN` | `true` | `false` = không tự mở tab trình duyệt khi khởi động |

## Lộ trình tiếp theo

- Giai đoạn 2: Hộp thư đến — lấy danh sách hội thoại + tin nhắn bằng cookie (GraphQL Facebook).
- Giai đoạn 3: Tự động trả lời, gắn thẻ khách hàng, thống kê.
- Cân nhắc thay lưu trữ JSON bằng SQLite khi dữ liệu lớn.
