package android.content; public class ClipData {
  public static class Item { public CharSequence getText(){ return null; } }
  public static ClipData newPlainText(CharSequence label, CharSequence text){ return new ClipData(); }
  public ClipDescription getDescription(){ return new ClipDescription(); }
  public int getItemCount(){ return 0; }
  public Item getItemAt(int i){ return new Item(); } }
