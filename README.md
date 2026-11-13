# OPNsense LAN Topology

Dashboard React và poller SNMP chạy cùng một tiến trình Node.js. Yêu cầu Node.js 22.12+ (nhánh 22) hoặc 24+.

## Chạy trên Linux

Từ thư mục dự án, chạy:

```sh
cp -n .env.example .env
cp -n config/devices.example.yaml config/devices.yaml
npm ci
npm start
```

Dashboard mặc định chạy mock trên `127.0.0.1:8080`. Trên Windows, dùng `Copy-Item` để tạo hai tệp cấu hình và `npm.cmd ci`, `npm.cmd start` để chạy.

## Mạng thật

- Giữ bind loopback và cấu hình `DASHBOARD_TOKEN` ngẫu nhiên trước khi bật mạng thật. Xem [SECURITY.md](SECURITY.md) để cấu hình HTTPS, đăng nhập và rule UDP 161 chỉ cho IP poller.
- Đặt `MOCK_MODE=false` trong `.env` và cấu hình SNMP chỉ đọc. Chỉ cho phép IP của poller truy cập UDP 161 trên mạng quản trị.
- Community SNMPv2c và khóa SNMPv3 nằm trong `.env`. Tên biến mặc định là `SNMP_COMMUNITY`, `SNMP_V3_AUTH_KEY` và `SNMP_V3_PRIV_KEY`. SNMPv3 yêu cầu authPriv và cả hai khóa. Chọn SHA-256 hoặc SHA-1 khớp với thiết bị, mã hóa AES-128.
- Bấm **Cấu hình thiết bị** hoặc chọn node trên sơ đồ để sửa IP, thiết bị cha, cổng nối và SNMP. Cổng nối dùng IF-MIB ifIndex trên thiết bị cha. Cổng WAN dùng ifIndex trên OPNsense. Lưu từ giao diện cập nhật sơ đồ ngay.
- `.env` và `config/devices.yaml` là dữ liệu riêng của từng máy. Khi chạy như dịch vụ, tài khoản Node.js cần quyền đọc `.env` và ghi vào thư mục chứa `devices.yaml`.
- `GET /healthz` kiểm tra tiến trình HTTP, `GET /api/topology` trả dữ liệu và `WS /ws/topology` truyền cập nhật.

Ví dụ mở dashboard qua SSH tunnel từ máy quản trị:

```sh
ssh -L 8080:127.0.0.1:8080 user@server
```

Sau đó mở http://127.0.0.1:8080 trên máy quản trị.
