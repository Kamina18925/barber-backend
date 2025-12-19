CREATE TABLE IF NOT EXISTS barber_breaks (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day CHAR(1) NOT NULL CHECK (day IN ('L','M','X','J','V','S','D')),
  break_type VARCHAR(20) NOT NULL CHECK (break_type IN ('breakfast','lunch','dinner')),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (barber_id, day, break_type)
);
