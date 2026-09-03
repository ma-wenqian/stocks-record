-- 港股买卖记录 · D1 表结构
-- 初始化：npm run db:init          （本地）
--         npm run db:init:remote   （线上）

DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE trades (
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

CREATE INDEX idx_trades_symbol_date ON trades(symbol, trade_date, id);
CREATE INDEX idx_trades_date        ON trades(trade_date DESC, id DESC);

-- 手动维护的当前价，用于计算未卖出持仓的市值与浮动盈亏
CREATE TABLE quotes (
  symbol     TEXT PRIMARY KEY,
  price      REAL NOT NULL CHECK (price >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);
