import { z } from "zod";

export type Post = {
  id: string;
  title: string;
  excerpt: string;
};

// CRUD form 入力 validation schema。
// Hibana の form は素 HTML <form method="POST"> + server validation で組む (= "MPA に client 制御を持ち込む" 哲学)、
// validation result は server で同 page を re-render する形で form に流す (= flash 不要、props で渡す)。
export const postInputSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(100, "title is too long"),
  excerpt: z.string().trim().min(1, "excerpt is required").max(500, "excerpt is too long"),
});

export type PostInput = z.infer<typeof postInputSchema>;
