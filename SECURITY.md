# Bảo mật

## Chạy với mạng thật

- Đặt `MOCK_MODE=false` và tạo token riêng cho dashboard bằng `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Lưu vào `DASHBOARD_TOKEN` trong môi trường máy chủ hoặc tệp `.env` chỉ tài khoản dịch vụ đọc được. Dùng HTTPS qua reverse proxy tin cậy hoặc truy cập loopback qua SSH tunnel.
- Giữ bind mặc định `127.0.0.1`. Khi dùng reverse proxy, đặt `DASHBOARD_ORIGIN` bằng đúng origin HTTPS bên ngoài, gồm cổng nếu có, và chuyển tiếp WebSocket. Giới hạn quyền truy cập trực tiếp cổng Node bằng firewall. Khi bind ngoài loopback ở chế độ thật, ứng dụng yêu cầu cấu hình origin HTTPS. TLS do reverse proxy kết thúc.
- Giao diện đăng nhập bằng token và nhận cookie HttpOnly, SameSite=Strict, hết hạn sau 8 giờ. Cookie HTTPS có cờ Secure. Khởi động lại backend sẽ thu hồi các cookie đã cấp. API client có thể gửi `Authorization: Bearer <token>` cho REST và WebSocket. Token dùng chung cấp toàn quyền xem và sửa. Giới hạn truy cập dashboard cho quản trị viên được tin cậy.
- Mock dành cho dữ liệu mẫu, không yêu cầu đăng nhập. Nếu cần bật lại mock, dùng tệp thiết bị mẫu riêng để tránh công khai sơ đồ thật. Giới hạn egress của tiến trình tới các IP/cổng SNMP quản trị và endpoint Speedtest tin cậy nếu dùng.
- Giữ `.env`, cấu hình thiết bị thật và log ngoài Git. Dữ liệu topology có thể tiết lộ IP, tên thiết bị và ánh xạ cổng. Nếu bí mật từng lọt vào lịch sử Git, xoay vòng bí mật và xử lý cả lịch sử trước khi công khai.

## OPNsense

1. Bật Net-SNMP và giới hạn Listen ở địa chỉ quản trị. Tạo user SNMPv3 **chỉ đọc** với `authPriv`, AES-128 và SHA-256 hoặc SHA-1 khớp thiết bị. Lưu cả hai khóa trên máy chạy poller. Nếu dùng v2c, dùng community chỉ đọc riêng và giới hạn trong mạng quản trị.
2. Trên interface nhận lưu lượng từ poller, tạo rule **Pass**, hướng In, Quick, UDP. Source là đúng IP máy poller (/32 IPv4 hoặc /128 IPv6), destination là đúng IP quản trị OPNsense, destination port 161.
3. Ngay dưới rule Pass, tạo rule **Block**, In, Quick, UDP, source any, cùng destination và cổng 161. Đặt hai rule trước rule LAN/VLAN cho phép rộng. Kiểm tra rule Floating và nhóm interface có thứ tự ưu tiên cao hơn. Với các interface khác có thể tiếp cận IP quản trị, chặn UDP 161 hoặc xác nhận default deny có hiệu lực. Giữ WAN không có rule pass hoặc port forward SNMP.
4. Áp dụng, kiểm tra bằng SNMP GET từ IP poller và từ một IP khác. IP poller phải đọc được uptime, nguồn còn lại phải bị chặn. Có thể bật logging cho rule block để kiểm tra.

Xem [thứ tự xử lý rule OPNsense](https://docs.opnsense.org/manual/firewall.html) và [cấu hình Net-SNMP](https://github.com/opnsense/plugins/blob/master/net-mgmt/net-snmp/src/opnsense/service/templates/OPNsense/Netsnmp/snmpd.conf).

## Báo lỗi bảo mật

Báo riêng cho người quản trị triển khai. Kèm phiên bản, cách tái hiện và ảnh hưởng. Xóa token, community, khóa và địa chỉ mạng thật khỏi nội dung gửi.
