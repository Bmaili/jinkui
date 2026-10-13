package android.content; public class Intent {
  public static final String ACTION_VIEW="v"; public static final int FLAG_GRANT_READ_URI_PERMISSION=1, FLAG_ACTIVITY_NEW_TASK=2;
  public Intent(){} public Intent(String a){} public Intent(String a, android.net.Uri u){} public Intent(Context c, Class<?> k){}
  public Intent setDataAndType(android.net.Uri u,String t){return this;} public Intent setData(android.net.Uri u){return this;} public Intent addFlags(int f){return this;}
  public Intent putExtra(String k, String v){return this;} public Intent putExtra(String k, android.os.Parcelable v){return this;}
  public String getStringExtra(String k){return null;} public <T extends android.os.Parcelable> T getParcelableExtra(String k){return null;} }
