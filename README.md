# bima

**dành cho người chơi hệ nạp tiền**


![](https://i.imgur.com/2wKu8QC.png)

## Hướng dẫn sử dụng

1. Tạo Firebase Project
2. Deploy

```bash
firebase deploy --only functions
```

3. Dùng [Cloud Scheduler](https://cloud.google.com/scheduler) gọi interval vào endpoint Cloud Funtions
