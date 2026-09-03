# 部署

零依赖，不用 Docker。一台能跑 Node 22+ 的机器就行，实测常驻内存 **28MB**。

下面以 Debian/Ubuntu + systemd + Caddy + Authelia 为例。换成 Nginx / Authentik / oauth2-proxy
思路一样 —— 应用只关心一件事：**请求头里有没有 `Remote-User`**。

---

## 1. 装 Node

`node:sqlite` 需要 Node 22+，**Node 24 起免实验标志**，推荐直接上 24：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs
node -v
```

确认 `node:sqlite` 可用（应该直接打印 `function`）：

```bash
node -e "import('node:sqlite').then(m => console.log(typeof m.DatabaseSync))"
```

如果只有 Node 22/23，要在启动命令里加 `--experimental-sqlite`。

## 2. 放代码

```bash
sudo mkdir -p /opt/stocks-record
sudo git clone https://github.com/ma-wenqian/stocks-record.git /tmp/sr
sudo cp -r /tmp/sr/server /tmp/sr/public /opt/stocks-record/
sudo rm -rf /tmp/sr
```

只需要 `server/` 和 `public/` 两个目录。

**表结构会在服务启动时自动建**（`server/schema.sql` 全是 `IF NOT EXISTS`），
没有「先初始化数据库」这一步。

## 3. systemd

```bash
sudo cp /opt/stocks-record/server/stocks-record.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stocks-record
systemctl status stocks-record
```

单元里几个值得注意的地方：

| 设置 | 为什么 |
| --- | --- |
| `DynamicUser=yes` | systemd 临时分配 uid，不用手工建账号 |
| `StateDirectory=stocks-record` | 数据库落在 `/var/lib/stocks-record/`（实际是 `/var/lib/private/` 下，只有这个服务能写） |
| `HOST=127.0.0.1` | **只绑回环，见下面那节** |
| `MemoryMax=200M` | 小内存机器上给个上限，别让它挤掉别的服务 |
| `LOGOUT_URL` | 「退出」按钮指向 IdP 的登出地址。不设就不显示这个按钮 |

改完单元记得 `systemctl daemon-reload`，否则 systemd 会一直提示配置已变。

## 4. 反向代理 + 认证

### ⚠️ 先读这一段

**应用无条件信任 `Remote-User` 头。** 这是 forward-auth 模式的前提 ——
代理先去问 IdP，通过了才把身份注入进来，后端不再重复认证。

**代价是：那个端口一旦对公网可达，任何人自带一个 `Remote-User: 谁谁` 就是谁谁。**

所以：

- `HOST=127.0.0.1`，**不要**改成 `0.0.0.0`
- 防火墙**不要**放行 `9310`
- 反向代理必须跑在同一台机器上（或走内网/tailnet，且那个端口只对代理开放）

部署完自己验一次：

```bash
# 本机不带头 —— 应该是 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9310/api/state

# 从别的机器打 —— 应该完全连不上
nc -zv <你的服务器IP> 9310
```

### Caddy + Authelia

```caddyfile
# 受保护的站点共用这一段
(protected) {
	forward_auth 127.0.0.1:9091 {
		uri /api/authz/auth-request
		header_up X-Original-URL "https://{http.request.host}{http.request.uri}"
		header_up X-Original-Method "{http.request.method}"
		copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
		@denied status 401 403
		handle_response @denied {
			redir https://auth.example.com/?rd=https://{http.request.host}{http.request.uri} 302
		}
	}
}

stocks.example.com {
	# ⚠️ 必须用 route 包起来 —— forward_auth 展开后也是一个 reverse_proxy，
	#    和后端那个平级时 Caddy 可能让鉴权那个先终结请求
	route {
		import protected
		reverse_proxy 127.0.0.1:9310
	}
}
```

Authelia 的 `access_control.rules`：

```yaml
    # ⚠️ 图标和 manifest 必须单独放行，而且要排在整域规则**前面**（首次匹配生效）。
    #    浏览器取这两样时**不带 cookie**，挡住的话会被 302 到登录页 ——
    #    表现是「添加到主屏幕」的图标是空白的，而页面本身一切正常，非常难查。
    - domain: 'stocks.example.com'
      resources:
        - '^/icons/.*$'
        - '^/manifest\.webmanifest$'
      policy: 'bypass'

    - domain: 'stocks.example.com'
      subject:
        - 'group:stocks'      # subject 的多条之间是「或」
      policy: 'two_factor'
```

> ⚠️ **规则不写 `subject` 等于「任何通过该 policy 的用户都放行」。**
> 如果你的 IdP 上还有别的应用，漏掉 `subject` 就是把那些应用也一并开放给新用户了。

放行 `/icons/` 不会开出后门 —— 路径是先归一化再匹配的，
`/icons/../api/state` 仍然会被拦（部署完可以自己 `curl --path-as-is` 验一下）。

### 不用 IdP

只想自己用、又不想架 IdP，就别暴露到公网，用 SSH 隧道：

```bash
ssh -L 9310:127.0.0.1:9310 你的服务器
# 然后本地浏览器开 http://127.0.0.1:9310/
```

但应用仍然需要 `Remote-User` 头才肯放行。这种用法下最简单的做法是在
`server/app.js` 的 `requireUser()` 里写死一个用户名。

---

## 5. 加人

**应用不管认证，加人就是在 IdP 那边加。** 应用这边什么都不用做 ——
新用户第一次访问时会自动登记一条，只为了给记录标归属。

以 Authelia 的 file 后端为例：

```bash
authelia crypto hash generate argon2      # 不带 --password 会交互式提示，不落 shell 历史
```

把哈希填进 `users_database.yml`，配置了 `watch: true` 的话**存盘即生效，不用重启**。

> ⚠️ Authelia 的 file 后端**要求每个用户都有 `password` 字段**，删掉它 Authelia 会
> **fatal 拒绝启动**（`could not validate the schema: ... non zero value required`），
> 后果是所有受保护站点一起 502。想做到「只能用 passkey 登录」，
> 做法是把密码设成随机且无人知晓的值，不是删掉它。

---

## 6. 账本按人隔离

`trades.created_by` 就是「这笔属于谁」，`quotes` 的主键是 `(user_id, symbol)`。
**每个查询都带归属条件**，两个人互相看不到。

改代码时四个地方特别容易漏，漏了不报错但结果是错的：

| 位置 | 漏了会怎样 |
| --- | --- |
| 改 / 删记录 | 能改别人的记录。归属条件要写进 `WHERE`，别写成「先查出来再判断」 |
| **卖超校验** | 会**借用对方的持仓**，于是你能卖出你没有的股票 |
| **名称沿用** | 从对方记录里取名称，等于泄露对方持有什么 |
| 行情 | 共享一份更省事，但 `symbol` 列本身就泄露了对方在跟哪几只 |

## 7. 更新

```bash
git clone https://github.com/ma-wenqian/stocks-record.git /tmp/sr
sudo cp -r /tmp/sr/server /tmp/sr/public /opt/stocks-record/
sudo systemctl restart stocks-record
rm -rf /tmp/sr
```

数据库结构变更由 `server/app.js` 里的 `migrate()` 处理，**每步都先探测再动手，重启无害**。

## 8. 备份

数据库就是一个文件：`/var/lib/stocks-record/stocks.sqlite3`。

⚠️ **WAL 模式下不能直接 `cp` 主文件** —— 可能拿到不一致的快照。先 checkpoint：

```bash
sudo node -e "
const {DatabaseSync} = require('node:sqlite');
const src = '/var/lib/private/stocks-record/stocks.sqlite3';
const db = new DatabaseSync(src);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
require('fs').copyFileSync(src, '/root/stocks-' + new Date().toISOString().slice(0,10) + '.sqlite3');
console.log('done');
"
```

装了 `sqlite3` 命令的话更简单：

```bash
sudo sqlite3 /var/lib/private/stocks-record/stocks.sqlite3 ".backup /root/stocks-$(date +%F).sqlite3"
```

> `DynamicUser=yes` 的服务，数据实际在 `/var/lib/private/` 下，**那个目录只有 root 能进**。
> 用服务账号在外面读会报 `unable to open database file` —— 备份脚本要用 root 跑。

## 9. 排障

```bash
journalctl -u stocks-record -n 50 --no-pager      # 应用日志
systemctl status stocks-record
curl -s -H 'Remote-User: test' http://127.0.0.1:9310/api/state   # 绕过代理直接问后端
```

| 现象 | 多半是 |
| --- | --- |
| 页面停在「未通过认证」 | 代理没注入 `Remote-User`。先用上面那条 curl 确认后端本身是好的，再查代理 |
| 登录后无限跳转 | 后端自带 basic auth，浏览器给整个源都发 `Authorization`，IdP 优先处理它、忽略了会话 cookie。在鉴权子请求里把这个头剥掉 |
| 加到主屏幕图标空白 | `/icons/` 和 manifest 没在 IdP 那边放行（见上文） |
| `MemoryMax` 被打爆 | 不太可能，正常常驻 28MB。真发生了先看 `journalctl` 有没有异常循环 |
