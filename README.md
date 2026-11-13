# OPNsense LAN Topology

Dashboard React và poller SNMP chạy cùng một tiến trình Node.js. Yêu cầu Node.js 26 LTS (khuyến nghị 26.13.1).

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
- Community SNMPv2c và khóa SNMPv3 nằm trong `.env`. Tên biến mặc định là `SNMP_COMMUNITY`, `SNMP_V3_AUTH_KEY` và `SNMP_V3_PRIV_KEY`. SNMPv3 yêu cầu authPriv và cả hai khóa. Chọn SHA-256, SHA-512 hoặc SHA-1 khớp với thiết bị, mã hóa AES-128 hoặc AES-256 Blumenthal/Reeder theo thiết bị.
- Bấm **Cấu hình thiết bị** hoặc chọn node trên sơ đồ để sửa IP, thiết bị cha, cổng nối và SNMP. Cổng nối dùng IF-MIB ifIndex trên thiết bị cha. Cổng WAN dùng ifIndex trên OPNsense. Lưu từ giao diện cập nhật sơ đồ ngay.
- `.env` và `config/devices.yaml` là dữ liệu riêng của từng máy. Khi chạy như dịch vụ, tài khoản Node.js cần quyền đọc `.env` và ghi vào thư mục chứa `devices.yaml`.
- `GET /healthz` kiểm tra tiến trình HTTP, `GET /api/topology` trả dữ liệu và `WS /ws/topology` truyền cập nhật.

Ví dụ mở dashboard qua SSH tunnel từ máy quản trị:

```sh
ssh -L 8080:127.0.0.1:8080 user@server
```

Sau đó mở http://127.0.0.1:8080 trên máy quản trị.

## Hai chế độ chạy

**Node.js / Windows / Nexora.** Cài bằng `npm install` hoặc `npm ci`. Dùng `npm run dev` hoặc `npm start` từ thư mục gốc. Cả hai lệnh build rồi chạy Express cùng dashboard trên một cổng. Trong Nexora, chọn lệnh npm `start`; ứng dụng ưu tiên `HOST` và `PORT` do Nexora cấp. Trên server chạy Node trực tiếp, đặt `NODE_ENV=production` và `PORT=3000` trong `.env` để phục vụ giao diện, API và WebSocket trên cổng 3000. Với lệnh npm có bước build, cài cả dev dependencies bằng `npm ci --include=dev` nếu môi trường shell đã đặt `NODE_ENV=production`.

**Docker Compose.** Tạo `.env` từ `.env.example` và `config/devices.yaml` từ `config/devices.example.yaml` nếu các tệp chưa tồn tại. Cấp quyền đọc tệp thiết bị cho UID của user `node` trong container. Từ thư mục gốc, chạy:

```sh
docker compose up -d --build
docker compose logs -f opnsense-monitor
```

Cổng mặc định trên máy chủ là `127.0.0.1:3000`. `PORT` trong `.env` đổi cổng phía máy chủ; trong container luôn là 3000. Để mở qua LAN, đặt `DASHBOARD_BIND_IP` bằng IP LAN cụ thể, giới hạn nguồn bằng firewall và dùng proxy HTTPS có hỗ trợ WebSocket cho mạng thật. Khi `MOCK_MODE=false`, đặt `DASHBOARD_TOKEN` và `DASHBOARD_ORIGIN` bằng origin HTTPS của proxy theo [SECURITY.md](SECURITY.md).

Compose gắn `config/devices.yaml` chỉ đọc. Để sửa danh sách thiết bị, cập nhật tệp trên máy chủ rồi chạy `docker compose up -d --force-recreate`. Tệp cấu hình thật và `.env` nằm ngoài image.

Dockerfile dùng `node:26-alpine`. Khi chạy Nexora, chọn Node.js 26.13.1 cho dự án trước khi khởi động lại.
