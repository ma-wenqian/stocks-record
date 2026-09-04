-- 港股买卖记录 · SQLite 表结构
--
-- users 表没有 password_hash：认证由 Authelia 做，
-- 这张表只是为了在流水里标出「谁记的」，
-- 第一次访问时由服务端自动登记。

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,          -- 来自 Remote-User
  display_name TEXT NOT NULL,                 -- 来自 Remote-Name
  cost_mode    TEXT NOT NULL DEFAULT 'avg',   -- 成本口径，见 accounting.js 的 COST_MODES
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  side       TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  trade_date TEXT NOT NULL,                      -- YYYY-MM-DD
  price      REAL NOT NULL CHECK (price >= 0),   -- 单价 HKD
  qty        REAL NOT NULL CHECK (qty > 0),      -- 股数
  fee        REAL NOT NULL DEFAULT 0,            -- 佣金+印花税等合计
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- created_by 就是「这笔属于谁」。每个查询都必须带上它 ——
-- 两个人的账本互相不可见，漏一处就是把别人的持仓算进你的盈亏里。
CREATE INDEX IF NOT EXISTS idx_trades_owner_symbol ON trades(created_by, symbol, trade_date, id);
CREATE INDEX IF NOT EXISTS idx_trades_owner_date   ON trades(created_by, trade_date DESC, id DESC);

-- 手动维护的当前价，用于计算未卖出持仓的市值与浮动盈亏。
-- 和 trades 一样按用户隔离：两个人各记各的账，互相看不到对方持有什么。
-- （共享一份行情表会更省事，但 symbol 列本身就泄露了对方在跟哪几只）
CREATE TABLE IF NOT EXISTS quotes (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  symbol     TEXT NOT NULL,
  price      REAL NOT NULL CHECK (price >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, symbol)
);
