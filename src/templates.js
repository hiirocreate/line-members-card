// 登録フォームテンプレート (master key の並び + 必須)。適用後に自由に編集可能。
const R = (key) => ({ key, required: true });
const O = (key) => ({ key, required: false });

export const TEMPLATES = {
  basic: { label: '基本', fields: [R('name'), R('phone')] },
  standard: { label: '標準顧客情報', fields: [R('name'), R('phone'), O('email'), O('address'), O('birthday')] },
  marketing: { label: '店舗マーケティング', fields: [R('name'), R('phone'), O('email'), O('birthday'), O('gender'), O('occupation'), { key: '__interest', required: false }] },
  detailed: { label: '詳細', fields: [R('name'), R('phone'), O('email'), O('address'), O('birthday'), O('gender'), O('occupation'),
    O('marital_status'), O('has_children'), { key: '__interest', required: false }] },
};

// 「興味・関心」はマスタに無いので、テンプレ適用時にカスタム項目として生成
export const INTEREST_FIELD = { field_name: '興味・関心', field_type: 'MULTI_SELECT', options: ['カット', 'カラー', 'パーマ', 'トリートメント'] };
