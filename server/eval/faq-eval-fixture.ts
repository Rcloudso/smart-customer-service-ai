import Database from 'better-sqlite3';
import { FaqRepo } from '../db/repos/faq.repo';
import { IntentCategory } from '../types/domain';

const FAQ_EVAL_FIXTURE = [
  {
    question: '如何申请退款？',
    answer: '登录账户，进入我的订单，选择订单并提交退款原因。',
    category: IntentCategory.REFUND,
    keywords: ['退款', '申请', '退货', '退钱', '返还'],
  },
  {
    question: '退款被拒绝怎么办？',
    answer: '请检查退款时效和商品状态，仍有疑问时申请人工审核。',
    category: IntentCategory.REFUND,
    keywords: ['退款', '拒绝', '驳回', '不通过', '申诉'],
  },
  {
    question: '如何查询订单状态？',
    answer: '登录后在我的订单中查看订单状态与物流信息。',
    category: IntentCategory.ORDER,
    keywords: ['订单', '查询', '状态', '物流', '配送', '快递'],
  },
  {
    question: '如何修改或取消订单？',
    answer: '未发货订单可申请修改或取消，已发货订单请联系人工。',
    category: IntentCategory.ORDER,
    keywords: ['修改', '取消', '订单', '更改', '撤销'],
  },
  {
    question: 'APP/网站无法登录怎么办？',
    answer: '检查网络和密码，清理缓存后重试，必要时重置密码。',
    category: IntentCategory.TECHNICAL,
    keywords: ['登录', '无法', '密码', '账号', '登入', '失败', '错误'],
  },
  {
    question: '页面显示异常或白屏怎么办？',
    answer: '刷新页面、清理缓存并使用受支持的最新浏览器。',
    category: IntentCategory.TECHNICAL,
    keywords: ['白屏', '异常', '卡顿', '闪退', 'bug', '故障', '显示'],
  },
  {
    question: '如何联系人工客服？',
    answer: '在对话中请求转人工，由客服人员继续处理。',
    category: IntentCategory.GENERAL,
    keywords: ['人工', '客服', '联系', '转接', '电话', '帮助'],
  },
  {
    question: '有哪些优惠活动？',
    answer: '请查看首页活动区了解当前有效的优惠与使用条件。',
    category: IntentCategory.GENERAL,
    keywords: ['优惠', '活动', '折扣', '促销', '满减', '秒杀', '优惠券'],
  },
] as const;

export function seedFaqEvalFixture(db: Database.Database): void {
  const repo = new FaqRepo(db);
  for (const faq of FAQ_EVAL_FIXTURE) {
    repo.create({ ...faq, keywords: [...faq.keywords], updatedBy: 'faq-eval-fixture' });
  }
}
