CREATE INDEX IF NOT EXISTS "Post_banter_visibility_idx"
ON public."Post" USING btree ("isRoast", status, "expiresAt", "createdAt");
