package android.service.autofill; public final class SaveInfo {
  public static final int SAVE_DATA_TYPE_PASSWORD=1, SAVE_DATA_TYPE_USERNAME=8, FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE=1;
  public static final class Builder {
    public Builder(int type, android.view.autofill.AutofillId[] required){}
    public Builder setOptionalIds(android.view.autofill.AutofillId[] ids){ return this; } public Builder setFlags(int f){ return this; }
    public Builder setDescription(CharSequence d){ return this; } public SaveInfo build(){ return new SaveInfo(); } } }
