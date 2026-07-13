import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { adminOnlyMiddleware } from '../../middleware/adminOnly';
import { authMiddleware } from '../../middleware/auth';
import { documentService } from '../../services/document-runtime';
import { ValidationError } from '../../utils/errors';

const router = Router();
router.use(authMiddleware);
router.use(adminOnlyMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const listSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  keyword: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const chunkListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const updateSchema = z.object({ isActive: z.boolean() }).strict();

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) throw validationFrom(parsed.error);
    const result = documentService.list({
      ...parsed.data,
      isActive: parsed.data.isActive === undefined ? null : parsed.data.isActive === 'true',
    });
    res.json({ code: 0, data: { ...result, page: parsed.data.page, pageSize: parsed.data.pageSize }, message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await receiveFile(req, res);
    if (!req.file) throw new ValidationError('Please upload a document');
    const document = await documentService.upload({
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      uploadedBy: req.user?.username ?? 'unknown',
    });
    res.status(201).json({ code: 0, data: document, message: 'Document accepted' });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/chunks', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chunkListSchema.safeParse(req.query);
    if (!parsed.success) throw validationFrom(parsed.error);
    const result = documentService.listChunks(req.params.id, parsed.data);
    res.json({ code: 0, data: { ...result, ...parsed.data }, message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const document = await documentService.retry(req.params.id);
    res.json({ code: 0, data: document, message: 'Document retry completed' });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ code: 0, data: documentService.get(req.params.id), message: 'ok' });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw validationFrom(parsed.error);
    const document = await documentService.setActive(req.params.id, parsed.data.isActive);
    res.json({ code: 0, data: document, message: 'Document updated' });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await documentService.delete(req.params.id);
    res.json({ code: 0, data: null, message: 'Document deleted' });
  } catch (error) {
    next(error);
  }
});

function receiveFile(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        reject(new ValidationError('Document exceeds the 10 MB limit'));
      } else if (error) {
        reject(new ValidationError('Document upload failed'));
      } else {
        resolve();
      }
    });
  });
}

function validationFrom(error: z.ZodError): ValidationError {
  return new ValidationError(error.errors.map((item) => item.message).join('; '));
}

export default router;
