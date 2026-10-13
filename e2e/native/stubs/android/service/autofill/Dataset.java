package android.service.autofill; public final class Dataset implements android.os.Parcelable {
  public static final class Builder {
    public Builder(){}
    public Builder(android.widget.RemoteViews p){}
    public Builder setValue(android.view.autofill.AutofillId id, android.view.autofill.AutofillValue v){ return this; }
    public Builder setValue(android.view.autofill.AutofillId id, android.view.autofill.AutofillValue v, android.widget.RemoteViews p){ return this; }
    public Builder setAuthentication(android.content.IntentSender s){ return this; }
    public Dataset build(){ return new Dataset(); } } }
