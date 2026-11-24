-- Fictional demo data for a small online store. No real people or companies.
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','refunded')),
  total_paise INTEGER NOT NULL,
  placed_at TEXT NOT NULL
);
CREATE TABLE support_notes (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO customers VALUES
 (1,'Asha Verma','asha@example.com','Hyderabad','2026-01-04'),
 (2,'Rahul Nair','rahul@example.com','Bengaluru','2026-01-19'),
 (3,'Meera Iyer','meera@example.com','Chennai','2026-02-02'),
 (4,'Kabir Shah','kabir@example.com','Pune','2026-02-27'),
 (5,'Divya Rao','divya@example.com','Hyderabad','2026-03-15');
INSERT INTO orders VALUES
 (101,1,'paid',249900,'2026-03-01'),
 (102,1,'shipped',89900,'2026-03-09'),
 (103,2,'refunded',159900,'2026-03-11'),
 (104,3,'paid',39900,'2026-03-20'),
 (105,4,'pending',549900,'2026-03-22'),
 (106,5,'shipped',129900,'2026-04-02'),
 (107,5,'paid',19900,'2026-04-05'),
 (108,2,'paid',74900,'2026-04-08');
INSERT INTO support_notes VALUES
 (1,103,'Customer reported damaged box; refund issued.','2026-03-13');
