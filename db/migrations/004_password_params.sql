-- Keep the scrypt parameters with each hash, so they can be raised for new
-- passwords without breaking the old ones. Existing rows used these values.

ALTER TABLE auth.users ADD COLUMN password_params TEXT NOT NULL DEFAULT 'scrypt:N=16384,r=8,p=1,len=64';
ALTER TABLE auth.users ALTER COLUMN password_params DROP DEFAULT;
