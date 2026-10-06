// 運営専用の使い方 (運営管理者にだけ API で返す。店舗の管理者・スタッフには見せない)
export const OPS_HELP = {
  title: '運営',
  lead: '運営専用の画面です。店舗・管理者・標準項目・禁止語を管理します。',
  steps: [
    '「店舗を作成」で、新しい店舗を追加します。店舗ごとに「機能設定」で、使える機能をオン/オフできます(オフにした機能は、その店舗の管理者・スタッフに表示されず、使えなくなります)。',
    '「管理者アカウント」で、店舗管理者・スタッフを作成し、仮パスワードやパスワードを設定できます。',
    '「標準項目マスタ」で、全店舗が使える標準の項目を増やせます。',
    '「禁止語」で、店舗が項目名に使えない言葉を決めます。',
  ],
  tips: [
    '店舗を選んでから各タブを開くと、その店舗の画面を操作できます。',
    '【自動配信のしくみ】予約メッセージ・誕生日配信は、Cloud Scheduler が10分おきに /api/cron/run を呼び出して動かします。ジョブ名は line-members-cron、認証は Authorization: Bearer <CRON_SECRET> です。',
    '【動作確認】Cloud Shell で「gcloud scheduler jobs run line-members-cron --location=asia-northeast1」を実行し、「gcloud logging read \'resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/api/cron/run"\' --limit 3 --format="value(timestamp,httpRequest.status)"」で結果を見ます。200 が正常、401 は合言葉(CRON_SECRET)の不一致です。',
    '【合言葉の更新】シークレット cron-secret に新しい版を追加 → Cloud Run を --update-secrets CRON_SECRET=cron-secret:latest で更新 → ジョブを --update-headers で更新、の順に行います(詳しくは導入手順書 docs/DEPLOY.md の §13・§16)。',
    '【店舗がすでにLINEチャネルを持っているとき】公式アカウント(Messaging API)と同じプロバイダーの中に、LINEログインチャネル+LIFFを作るか追加します(ユーザーIDはプロバイダーごとに別のため)。店舗から、LIFF ID・ログインチャネルID・チャネルアクセストークン(長期)を受け取り、「LINE連携」に登録します。詳しくは導入手順書 docs/DEPLOY.md の §25。',
    'これらの運営向けの手順は、店舗の管理者・スタッフの画面には表示されません。',
  ],
};
