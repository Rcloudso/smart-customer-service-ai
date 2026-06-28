import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getDatabase } from '../db';
import { AdminRepo } from '../db/repos/admin.repo';
import { config } from '../config';
import { ValidationError, AuthError } from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { username, password } = parsed.data;
    const db = getDatabase();
    const adminRepo = new AdminRepo(db);

    const user = adminRepo.findByUsername(username);
    if (!user) {
      throw new AuthError('用户名或密码错误');
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new AuthError('用户名或密码错误');
    }

    const tokenPayload = {
      id: user.id,
      username: user.username,
      role: user.role,
    };

    const token = jwt.sign(tokenPayload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    logger.info({ userId: user.id, username: user.username }, 'Admin login successful');

    res.json({
      code: 0,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      },
      message: 'ok',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
