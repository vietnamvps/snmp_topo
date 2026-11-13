# Bảo mật

## Chạy với mạng thật

- Đặt `MOCK_MODE=false` và tạo tài khoản quản trị từ ADMIN_USERNAME/ADMIN_PASSWORD. DASHBOARD_TOKEN chỉ dùng cho Bearer automation.
- Giữ bind mặc định `127.0.0.1`. Khi dùng reverse proxy, đặt `DASHBOARD_ORIGIN` bằng đúng origin HTTPS bên ngoài, gồm cổng nếu có, và chuyển tiếp WebSocket. Giới hạn quyền truy cập trực tiếp cổng Node bằng firewall. Khi bind ngoài loopback ở chế độ thật, ứng dụng mặc định yêu cầu origin HTTPS. TLS do reverse proxy kết thúc.
- Đăng nhập bằng tài khoản. SQLite lưu hash Argon2id của mật khẩu và SHA-256 của token phiên. Cookie HttpOnly, SameSite=Strict, Secure theo origin. Phiên mặc định 8 giờ hoặc 30 ngày khi ghi nhớ, và được thu hồi khi đổi mật khẩu hoặc vô hiệu hóa tài khoản. Bearer token dành cho API automation, không cấp quyền API quản lý tài khoản.
- Mock dành cho dữ liệu mẫu, không yêu cầu đăng nhập. Nếu cần bật lại mock, dùng tệp thiết bị mẫu riêng để tránh công khai sơ đồ thật. Giới hạn egress của tiến trình tới các IP/cổng SNMP quản trị và endpoint Speedtest tin cậy nếu dùng.
- Giữ `.env`, cấu hình thiết bị thật và log ngoài Git. Dữ liệu topology có thể tiết lộ IP, tên thiết bị và ánh xạ cổng. Nếu bí mật từng lọt vào lịch sử Git, xoay vòng bí mật và xử lý cả lịch sử trước khi công khai.

## OPNsense

1. Bật Net-SNMP và giới hạn Listen ở địa chỉ quản trị. Tạo user SNMPv3 **chỉ đọc** với `authPriv`, AES-128 hoặc AES-256 Blumenthal/Reeder và SHA-256, SHA-512 hoặc SHA-1 khớp thiết bị. Lưu cả hai khóa trên máy chạy poller. Nếu dùng v2c, dùng community chỉ đọc riêng và giới hạn trong mạng quản trị.
2. Trên interface nhận lưu lượng từ poller, tạo rule **Pass**, hướng In, Quick, UDP. Source là đúng IP máy poller (/32 IPv4 hoặc /128 IPv6), destination là đúng IP quản trị OPNsense, destination port 161.
3. Ngay dưới rule Pass, tạo rule **Block**, In, Quick, UDP, source any, cùng destination và cổng 161. Đặt hai rule trước rule LAN/VLAN cho phép rộng. Kiểm tra rule Floating và nhóm interface có thứ tự ưu tiên cao hơn. Với các interface khác có thể tiếp cận IP quản trị, chặn UDP 161 hoặc xác nhận default deny có hiệu lực. Giữ WAN không có rule pass hoặc port forward SNMP.
4. Áp dụng, kiểm tra bằng SNMP GET từ IP poller và từ một IP khác. IP poller phải đọc được uptime, nguồn còn lại phải bị chặn. Có thể bật logging cho rule block để kiểm tra.

Xem [thứ tự xử lý rule OPNsense](https://docs.opnsense.org/manual/firewall.html) và [cấu hình Net-SNMP](https://github.com/opnsense/plugins/blob/master/net-mgmt/net-snmp/src/opnsense/service/templates/OPNsense/Netsnmp/snmpd.conf).

## Báo lỗi bảo mật

Báo riêng cho người quản trị triển khai. Kèm phiên bản, cách tái hiện và ảnh hưởng. Xóa token, community, khóa và địa chỉ mạng thật khỏi nội dung gửi.

Dùng ALLOWED_ORIGINS để cho phép các origin cụ thể, phân tách bằng dấu phẩy. CORS API liên origin hỗ trợ Bearer token. Giới hạn toàn tiến trình là 1.200 yêu cầu API và 240 lần nâng cấp WebSocket mỗi phút. Payload WebSocket đầu vào tối đa 1 KiB.

## Trusted LAN over HTTP

Set `ALLOW_INSECURE_LAN_HTTP=true` and set `DASHBOARD_ORIGIN` to the exact HTTP origin, including the published port. Use a private or loopback IP literal. Live mode still requires token authentication. Restrict access to trusted clients because HTTP sends credentials and telemetry without transport encryption.

Giữ thư mục SQLite và bản sao lưu ngoài Git. Tài khoản dịch vụ cần quyền ghi riêng vào thư mục dữ liệu. Xóa biến bootstrap sau khi tạo admin. Chế độ mock giữ quyền xem và chỉnh thiết bị mẫu khi chưa đăng nhập.

- Device inventory lives in SQLite. Admin device changes record before/after values in the audit log. YAML exports and audit records include SNMP environment-variable names only. Keep exported topology files private because they contain management addresses.
- Compose mounts the configuration directory read-only for one-time seeding. Preserve the existing SQLite data directory when upgrading. `DEVICES_READ_ONLY=true` blocks device mutations through the API.
