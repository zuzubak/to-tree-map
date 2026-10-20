{# Title-case a street name.
   The tree inventory stores names in capitals ("QUEEN ST W") and the centreline
   stores them mixed ("Queen St W"). A block label draws cross streets from both, so
   one of them has to be converted or the label reads half-shouted. DuckDB has no
   initcap, hence the split-transform-join. #}
{% macro title_case(col) %}
array_to_string(
    list_transform(
        str_split(lower(trim({{ col }})), ' '),
        w -> upper(w[1:1]) || w[2:]
    ),
    ' '
)
{% endmacro %}
