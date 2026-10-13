package android.service.autofill; public final class FillResponse {
  // 故意不提供 setAuthentication(ids, sender, presentation)：整个响应要验证时，填充窗口交回的 Dataset 会被系统丢掉（规格 5.8）。
  public static final class Builder {
    public Builder addDataset(Dataset d){ return this; }
    public Builder setSaveInfo(SaveInfo i){ return this; } public FillResponse build(){ return new FillResponse(); } } }
