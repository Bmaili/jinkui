package android.service.autofill; public abstract class AutofillService extends android.app.Service {
  public abstract void onFillRequest(FillRequest r, android.os.CancellationSignal s, FillCallback c);
  public abstract void onSaveRequest(SaveRequest r, SaveCallback c); }
