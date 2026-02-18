ALTER TABLE "Comment" ADD COLUMN "parentId" TEXT;

ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Comment_parentId_idx" ON "Comment"("parentId");
