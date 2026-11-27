# Playwright Studio

## Khởi động

Mở terminal WSL 2 Ubuntu/Debian trong thư mục repo và chạy:

```bash
bash start.sh
```

Script kiểm tra Docker, Compose và Buildx, tự cài thành phần còn thiếu từ kho Docker chính thức và khởi động Docker Engine. Lần đầu cần Internet và có thể yêu cầu mật khẩu `sudo`; không cần cài Node/npm/Playwright riêng. Distro khác cần tự cài Docker cùng các plugin trước.

Nếu dùng Docker Desktop trên Windows, mở Docker Desktop và bật **Settings → Resources → WSL Integration** cho distro hiện tại trước khi chạy script.

Chờ container khởi tạo rồi mở **[Web Manager](http://localhost:8081)**.

## Tắt hệ thống

```bash
bash shutdown.sh
```

Project, script và dataset trong volume được giữ lại cho lần chạy sau.

## Sử dụng Web Manager

1. **Tạo project** ở sidebar. Chọn project để quản lý các test script; nút **Đổi tên project** và **Clone project** nằm trên thanh trên cùng.
2. **Dataset / .env:** tạo môi trường staging/production, nhập biến thủ công hoặc import `.env`, lưu và chọn môi trường trước khi ghi/chạy script.
3. **Tạo test script:** nhập tên file và URL → **Bắt đầu ghi thao tác** → thao tác trong Browser Desktop → **Dừng và lưu test script**. Dữ liệu nhập tự chuyển thành `data("TênBiến")` và được thêm vào dataset của môi trường đã chọn. File trùng tên cần xác nhận ghi đè.
4. **Xem/sửa script:** bấm tên script rồi **Chỉnh sửa**. Giá trị hardcode bạn nhập thủ công được lưu nguyên trong file; không tự cập nhật dataset.
5. **Chạy test:** bấm **Chạy trong UI** cho một file, hoặc tick nhiều file/**All** rồi **Chạy nhóm trong UI**. Playwright UI mở trong tab mới, chọn đúng project/môi trường và chạy lần lượt các file đã chọn. Sau khi đổi tên project, mở lại UI từ Manager.
6. **Copy script:** dùng menu `···` cho một file hoặc chọn nhiều file rồi **Copy sang project**. Dataset dùng cấu hình project đích; kiểm tra đủ biến trước khi chạy.

Script tự sao lưu vào `tests-scripts/<tên-project>/` trong thư mục repo. Sửa script đang chạy bằng Manager; thư mục local này là bản sao để xem/backup.
