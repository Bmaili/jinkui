package android.app; public final class PendingIntent {
  public static final int FLAG_CANCEL_CURRENT=1<<28, FLAG_IMMUTABLE=1<<26, FLAG_MUTABLE=1<<25;
  public static PendingIntent getActivity(android.content.Context c, int code, android.content.Intent i, int flags){ return new PendingIntent(); }
  public android.content.IntentSender getIntentSender(){ return null; } }
