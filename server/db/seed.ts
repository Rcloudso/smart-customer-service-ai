import bcrypt from 'bcrypt';
import { getDatabase } from './index';
import { AdminRepo } from './repos/admin.repo';
import { FaqRepo } from './repos/faq.repo';
import { AdminRole, IntentCategory } from '../types/domain';
import { config } from '../config';
import { logger } from '../utils/logger';

const SEED_FAQS: Array<{
  question: string;
  answer: string;
  category: IntentCategory;
  keywords: string[];
}> = [
  {
    question: '如何申请退款？',
    answer: '您可以通过以下步骤申请退款：1. 登录您的账户；2. 进入"我的订单"页面；3. 找到需要退款的订单，点击"申请退款"按钮；4. 填写退款原因并提交。我们会在1-3个工作日内审核您的退款申请。',
    category: IntentCategory.REFUND,
    keywords: ['退款', '申请', '退货', '退钱', '返还'],
  },
  {
    question: '退款需要多长时间到账？',
    answer: '退款审核通过后，款项到账时间取决于您的支付方式：支付宝/微信支付通常在1-3个工作日内到账；银行卡退款可能需要3-7个工作日；信用卡退款可能需要7-15个工作日。如超时未到账请联系客服。',
    category: IntentCategory.REFUND,
    keywords: ['退款', '到账', '时间', '多久', '到款'],
  },
  {
    question: '退款被拒绝怎么办？',
    answer: '如果您的退款申请被拒绝，可能有以下原因：1. 超出退款时效（通常为购买后7天内）；2. 商品已使用或影响二次销售；3. 特价/促销商品不支持退款。您可以联系客服了解具体原因并申请人工审核。',
    category: IntentCategory.REFUND,
    keywords: ['退款', '拒绝', '驳回', '不通过', '申诉'],
  },
  {
    question: '如何查询订单状态？',
    answer: '您可以通过以下方式查询订单状态：1. 登录账户进入"我的订单"页面查看订单详情；2. 在订单详情中可看到订单当前状态（待付款/已付款/配送中/已签收/已完成）；3. 点击订单可查看物流追踪信息。',
    category: IntentCategory.ORDER,
    keywords: ['订单', '查询', '状态', '物流', '配送', '快递'],
  },
  {
    question: '订单发货后多久能收到？',
    answer: '标准配送通常在3-5个工作日送达，加急配送1-2个工作日送达。具体送达时间会受收货地址和物流公司影响。您可以在订单详情中查看预计送达时间和实时物流信息。',
    category: IntentCategory.ORDER,
    keywords: ['发货', '配送', '送达', '物流', '快递', '多久'],
  },
  {
    question: '如何修改或取消订单？',
    answer: '订单在"待付款"状态下可以自由取消；"已付款未发货"状态下可以申请取消，审核通过后取消；"已发货"状态下无法取消订单，但可以在收到商品后申请退款。修改订单信息（如收货地址）请在订单未发货时联系客服。',
    category: IntentCategory.ORDER,
    keywords: ['修改', '取消', '订单', '更改', '撤销'],
  },
  {
    question: 'APP/网站无法登录怎么办？',
    answer: '如遇到登录问题，请尝试以下步骤：1. 检查网络连接是否正常；2. 确认账号和密码是否输入正确；3. 清除APP缓存或浏览器Cookie后重试；4. 尝试使用"忘记密码"功能重置密码；5. 如仍无法解决，请联系客服提供账号信息和错误截图。',
    category: IntentCategory.TECHNICAL,
    keywords: ['登录', '无法', '密码', '账号', '登入', '失败', '错误'],
  },
  {
    question: '支付失败怎么处理？',
    answer: '支付失败可能由以下原因导致：1. 银行卡余额不足或信用额度不足；2. 支付密码输入错误；3. 网络连接不稳定；4. 超过单笔或单日支付限额。建议您：检查账户余额→更换支付方式→切换网络环境→联系银行确认卡片状态。如持续失败请联系客服。',
    category: IntentCategory.TECHNICAL,
    keywords: ['支付', '失败', '付款', '扣款', '交易', '银行卡'],
  },
  {
    question: '页面显示异常或白屏怎么办？',
    answer: '页面异常通常可以通过以下方式解决：1. 刷新页面（Ctrl+F5强制刷新）；2. 清除浏览器缓存和Cookie；3. 更换浏览器（推荐Chrome/Edge最新版）；4. 检查网络连接；5. 如使用APP，尝试关闭后重新打开或更新到最新版本。',
    category: IntentCategory.TECHNICAL,
    keywords: ['白屏', '异常', '卡顿', '闪退', 'bug', '故障', '显示'],
  },
  {
    question: '客服工作时间是什么时候？',
    answer: '我们的在线客服工作时间：周一至周日 9:00-21:00（法定节假日除外）。您可以通过在线聊天、电话（400-XXX-XXXX）或邮件（support@example.com）联系我们。非工作时间可留言，我们会在下一个工作日优先处理。',
    category: IntentCategory.GENERAL,
    keywords: ['客服', '时间', '工作时间', '电话', '联系', '人工'],
  },
  {
    question: '如何联系人工客服？',
    answer: '您可以通过以下方式联系人工客服：1. 在本对话中说"转人工"或"人工客服"，系统将为您转接；2. 拨打客服热线 400-XXX-XXXX；3. 发送邮件至 support@example.com；4. 通过微信公众号留言。人工客服工作时间为 9:00-21:00。',
    category: IntentCategory.GENERAL,
    keywords: ['人工', '客服', '联系', '转接', '电话', '帮助'],
  },
  {
    question: '有哪些优惠活动？',
    answer: '我们定期推出各类优惠活动，包括：1. 新用户首单优惠（注册即享）；2. 满减活动（满200减30等）；3. 限时秒杀（每日10点/15点/20点）；4. 会员专属折扣；5. 节假日促销活动。请关注首页Banner和推送通知了解最新优惠！',
    category: IntentCategory.GENERAL,
    keywords: ['优惠', '活动', '折扣', '促销', '满减', '秒杀', '优惠券'],
  },
  {
    question: '商品有质量问题怎么办？',
    answer: '如收到商品存在质量问题，请您：1. 在签收后24小时内拍照留证；2. 联系客服说明情况并上传照片；3. 我们核实后将为您安排退换货或退款。质量问题商品我们承担来回运费，请放心购买。',
    category: IntentCategory.REFUND,
    keywords: ['质量', '问题', '损坏', '破损', '瑕疵', '退换', '换货'],
  },
  {
    question: '订单已支付但显示未付款？',
    answer: '这种情况通常是由于支付通知延迟导致的。请先确认：1. 查看银行/支付平台是否有实际扣款记录；2. 如果没有扣款，说明支付未成功，请重新支付；3. 如果已扣款但订单仍显示未付款，请保留扣款凭证并联系客服，我们会手动核实并更新订单状态。系统通常会在30分钟内自动对账。',
    category: IntentCategory.ORDER,
    keywords: ['已支付', '未付款', '支付成功', '扣款', '对账'],
  },
];

export async function seed(): Promise<void> {
  logger.info('Starting database seed...');
  const db = getDatabase();
  const adminRepo = new AdminRepo(db);
  const faqRepo = new FaqRepo(db);

  // Seed admin user
  const existingAdmin = adminRepo.findByUsername(config.admin.username);
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(config.admin.password, 10);
    adminRepo.create(config.admin.username, passwordHash);
    logger.info({ username: config.admin.username }, 'Admin user created');

    // Warn if using default credentials in production
    if (config.admin.password === 'admin123' && config.nodeEnv === 'production') {
      logger.warn('⚠️  Admin password is the default "admin123". Change it immediately in production!');
    }
  } else {
    logger.info('Admin user already exists, skipping');
  }

  // Seed FAQ entries
  const existingFaqs = faqRepo.listAllActive();
  if (existingFaqs.length === 0) {
    for (const faq of SEED_FAQS) {
      faqRepo.create({
        question: faq.question,
        answer: faq.answer,
        category: faq.category,
        keywords: faq.keywords,
        updatedBy: 'system',
      });
    }
    logger.info({ count: SEED_FAQS.length }, 'FAQ entries seeded');
  } else {
    logger.info({ count: existingFaqs.length }, 'FAQs already exist, skipping');
  }

  logger.info('Database seed completed');
}

// Run directly
if (require.main === module) {
  seed()
    .then(() => {
      logger.info('Seed finished successfully');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
